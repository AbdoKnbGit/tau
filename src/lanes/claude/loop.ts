/**
 * Claude Lane — loop shim.
 *
 * See `./index.ts` for the rationale. This lane is currently a
 * registration-only shim: it advertises supported models + the
 * small-fast model so /lane and /models UX are uniform, but it does
 * NOT handle requests. The dispatcher's `isAnthropicModel` special
 * case keeps Claude traffic on the existing `services/api/claude.ts`
 * path — which IS the native Anthropic Messages API path that Claude
 * Code upstream built.
 *
 * When / if we ever need to override Claude behavior (multi-org
 * rotation, lane-specific cache-marker placement, etc.), implement
 * `streamAsProvider` here, remove the dispatcher's `isAnthropicModel`
 * early return, and flip `isHealthy()` to `true`.
 */

import type {
  AnthropicStreamEvent,
  ModelInfo,
} from '../../services/api/providers/base_provider.js'
import type {
  Lane,
  LaneProviderCallParams,
  LaneRunContext,
  LaneRunResult,
  NormalizedUsage,
} from '../types.js'

export class ClaudeLane implements Lane {
  readonly name = 'claude'
  readonly displayName = 'Anthropic Claude (native Messages API)'

  private _healthy = false

  supportsModel(model: string): boolean {
    const m = model.toLowerCase()
    return (
      m.startsWith('claude-')
      || m.includes('anthropic/')
      || m.includes('anthropic.')
    )
  }

  // This function exists to satisfy the Lane interface; the dispatcher
  // never reaches it for Claude models (isAnthropicModel early return).
  // If it were called, we'd have a bug — throw loudly.
  async *streamAsProvider(
    _params: LaneProviderCallParams,
  ): AsyncGenerator<AnthropicStreamEvent, NormalizedUsage> {
    throw new Error(
      'ClaudeLane.streamAsProvider invoked unexpectedly — Claude models '
      + 'should go through the existing services/api/claude.ts path. '
      + 'If you hit this, the dispatcher\'s isAnthropicModel special '
      + 'case may have been removed prematurely.',
    )
  }

  async *run(_ctx: LaneRunContext): AsyncGenerator<AnthropicStreamEvent, LaneRunResult> {
    // Registration-only; never actually invoked.
    return {
      stopReason: 'end_turn',
      usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0, thinking_tokens: 0,
      },
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Curated Anthropic model list. Mirrors what the legacy provider
    // catalog surfaces. Flip to a live /v1/models call when Anthropic
    // makes that available on the Messages API.
    return [
      { id: 'claude-opus-4-8',        name: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7',        name: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6',        name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6',      name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5',       name: 'Claude Haiku 4.5 (fast)' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (fast, dated)' },
    ]
  }

  resolveModel(model: string): string {
    return model
  }

  smallFastModel(): string {
    // Haiku 4.5 is the canonical cheap+fast Claude for session titles,
    // tool-use summaries, commit-message drafts. Matches configs.ts's
    // firstParty default.
    return 'claude-haiku-4-5-20251001'
  }

  isHealthy(): boolean {
    return this._healthy
  }

  setHealthy(healthy: boolean): void {
    this._healthy = healthy
  }

  dispose(): void {
    // No resources — the Anthropic SDK is managed by claude.ts.
  }
}

export const claudeLane = new ClaudeLane()
