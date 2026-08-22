/**
 * NVIDIA NIM transformer.
 *
 * - Strips `stream_options` (NIM's validator rejects the field on
 *   some model deployments).
 * - Caps large Claude-style `max_tokens` reservations by default; the
 *   native lane bypasses the legacy NIM provider optimizer.
 * - Trims the advertised tool set for NIM's hosted/free queues, where
 *   oversized requests are the main latency killer.
 * - Honors `function.strict: true`.
 */

import type { Transformer, TransformContext } from './base.js'
import type { OpenAIChatRequest } from './shared_types.js'
import { ALL_NIM_MODELS } from '../../../utils/model/nim_catalog.js'
import {
  areNimOptimizationsDisabled,
  isNimFastToolFilterActive,
  isToolKeptByNimFastFilter,
} from '../nim_tool_policy.js'

const DEFAULT_NIM_MAX_TOKENS = 8192

export const nimTransformer: Transformer = {
  id: 'nim',
  displayName: 'NVIDIA NIM',
  defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',

  supportsStrictMode: () => true,

  staticCatalog() {
    return ALL_NIM_MODELS.map(model => ({
      id: model.id,
      name: model.name,
    }))
  },

  preferLiveModelCatalog(): boolean {
    return true
  },

  // NIM's /v1/models surfaces hundreds of preview/junk endpoints and
  // often returns the same id multiple times across deployments
  // (e.g. `openai/gpt-oss-120b` appears 6× under different aliases).
  // Restrict to the curated catalog and dedupe by id so /models only
  // shows our short list once.
  filterModelCatalog(models) {
    const allowed = new Set(ALL_NIM_MODELS.map(m => m.id))
    const seen = new Set<string>()
    const out: Array<{ id: string; name?: string }> = []
    for (const m of models) {
      if (typeof m.id !== 'string' || !allowed.has(m.id)) continue
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
    return out
  },

  clampMaxTokens(requested: number): number {
    if (areNimOptimizationsDisabled()) return requested
    const cap = readPositiveIntEnv('NIM_MAX_TOKENS')
      ?? readPositiveIntEnv('PROVIDER_MAX_TOKENS')
      ?? DEFAULT_NIM_MAX_TOKENS
    return requested > cap ? cap : requested
  },

  transformRequest(body: OpenAIChatRequest, _ctx: TransformContext): OpenAIChatRequest {
    delete body.stream_options
    return body
  },

  schemaDropList(): Set<string> {
    return new Set(['$schema', '$id', '$ref', '$comment'])
  },

  contextExceededMarkers(): string[] {
    return ['context length', 'token limit', 'prompt is too long']
  },

  preferredEditFormat(_model: string): 'apply_patch' | 'edit_block' | 'str_replace' {
    return 'edit_block'
  },

  smallFastModel(_model: string): string | null {
    // NIM's catalog varies per deployment — no reliable small model.
    return null
  },

  cacheControlMode(): 'none' | 'passthrough' | 'last-only' {
    return 'none'
  },

  filterTools<T extends { name: string }>(_model: string, tools: T[]): T[] {
    if (!isNimFastToolFilterActive()) return tools
    return tools.filter(t => isToolKeptByNimFastFilter(t.name))
  },

  skipToolUsagePreamble(_model: string): boolean {
    if (areNimOptimizationsDisabled()) return false
    return !(envFlag('NIM_TOOL_PREAMBLE') || envFlag('CLAUDEX_NIM_TOOL_PREAMBLE'))
  },
}

function envFlag(name: string): boolean {
  const value = process.env[name]
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function readPositiveIntEnv(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}
