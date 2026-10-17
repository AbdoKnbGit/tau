import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import type { APIProvider } from './model/providers.js'
import type { PowerMode } from './powerMode.js'
import { isSmallTierGroqModel } from '../lanes/openai-compat/groq_tool_policy.js'
import { isNimFastToolFilterActive } from '../lanes/openai-compat/nim_tool_policy.js'

/**
 * Providers routed through Tau's Gemini or OpenAI-compatible lanes. These
 * lanes implement tool discovery client-side: undeclared schemas stay in
 * Tau, ToolSearch records the selected names, and the selected schemas are
 * appended on the following request.
 *
 * Keep this list narrower than `isThirdPartyProvider()`. A provider belongs
 * here only when its active lane calls the shared lazy-tool selector. Unknown
 * and dedicated lanes deliberately fall back to eager schemas.
 * OpenRouter and OpenCode deliberately stay eager: exposing names without
 * contracts lets routed models guess arguments, and loading contracts later
 * changes the cached prefix. They send the full permitted toolset initially.
 * Gemini, Model Router, Vercel, Requesty, Groq, NIM, Copilot and iFlow stay
 * eager for the same two reasons. Ollama and LM Studio keep on-demand tools:
 * they run locally, where every schema up front can overflow a small context
 * window.
 */
const CLIENT_SIDE_TOOL_DISCOVERY_PROVIDERS: ReadonlySet<APIProvider> = new Set([
  'lxd',
  'mimo',
  'fireworks',
  'cloudflare',
  'mistral',
  'deepseek',
  'glm',
  'moonshot',
  'minimax',
  'alibaba',
  'ollama',
  'lmstudio',
])

export function providerSupportsClientSideToolDiscovery(
  provider: APIProvider,
): boolean {
  return CLIENT_SIDE_TOOL_DISCOVERY_PROVIDERS.has(provider)
}

/**
 * Providers whose prompt cache is an EXACT PREFIX cache that Tau cannot
 * re-anchor once it breaks.
 *
 * Client-side discovery rewrites the tool array mid-session: every ToolSearch
 * load appends schemas to the front of the request. On these providers the
 * tool block sits inside the cached prefix, so one load voids the whole
 * conversation cache and the next N turns re-send it uncached -- then the
 * following load does it again. Measured on real sessions: 79-87% of all
 * uncached input on deepseek/mimo/fireworks was re-sent prefix, not new
 * content, with the collapses landing within three turns of a ToolSearch
 * call (mimo 75%, fireworks 50%, deepseek 44%).
 *
 * Two shapes qualify, and neither gives Tau a breakpoint to re-anchor on:
 *   - automatic/implicit prefix caching (deepseek, mimo, alibaba, whose
 *     Model Studio implicit cache is always on and cannot be disabled, glm,
 *     whose Z.ai context cache is implicit, and minimax, which matches tools,
 *     then system, then messages on its own). Tau freezes the environment
 *     block of glm and minimax for that cache (direct_history.ts); a load
 *     rewrote the tool block in front of it anyway.
 *   - a session-pinned `prompt_cache_key` reusing one backend's KV cache
 *     (fireworks, moonshot, cloudflare, mistral, lxd)
 *
 * Deliberately NOT here:
 *   - openrouter / opencode / opencodego, gemini, modelrouter, vercel,
 *     requesty, groq, nim, copilot, iflow — always eager, independently of
 *     this set: none of them is a client-side discovery provider.
 *   - ollama / lmstudio — local, where the scarce resource is context window
 *     rather than a billed cache; schema savings are worth the re-prefill.
 */
const EXACT_PREFIX_CACHE_PROVIDERS: ReadonlySet<APIProvider> = new Set([
  'deepseek',
  'mimo',
  'alibaba',
  'fireworks',
  'moonshot',
  'cloudflare',
  'mistral',
  'lxd',
  'glm',
  'minimax',
])

/**
 * True when rewriting the tool array mid-session would void this provider's
 * prompt cache with no way to re-anchor it. Consulted by BOTH tool-deferral
 * gates so they cannot drift apart -- the exact failure the Antigravity
 * opt-out comment in utils/toolSearch.ts documents.
 */
export function providerUsesExactPrefixCache(provider: APIProvider): boolean {
  return EXACT_PREFIX_CACHE_PROVIDERS.has(provider)
}

/**
 * Model-aware companion to the provider allowlist. A provider may normally
 * use client-side discovery while a model-specific request transformer or
 * route cannot. Those requests must stay eager so the execution guard agrees
 * with the schemas that were actually sent.
 */
export function providerModelSupportsClientSideToolDiscovery(
  provider: APIProvider,
  model?: string,
): boolean {
  if (!providerSupportsClientSideToolDiscovery(provider)) return false
  // Rewriting the tool array would void a prefix cache Tau cannot re-anchor.
  if (providerUsesExactPrefixCache(provider)) return false
  // NIM prunes to a fixed fast subset before the lazy selector. Keeping
  // ToolSearch active there would advertise/select schemas the transformer
  // can never send.
  if (provider === 'nim' && isNimFastToolFilterActive()) return false
  if (!model) return true

  // Groq's small-tier filter deliberately removes ToolSearch while retaining
  // callable WebSearch/WebFetch/MCP schemas. Treat that final toolset as eager.
  if (provider === 'groq' && isSmallTierGroqModel(model)) return false

  return true
}

/**
 * True only when Tau has a verified discovery transport for this provider.
 * Everything else gets full schemas. This is the central safety fallback:
 * adding a provider never silently opts it into name-only tools.
 */
export function providerSupportsSafeToolDiscovery(
  provider: APIProvider,
): boolean {
  return (
    providerSupportsAnthropicToolSearch(provider) ||
    providerSupportsClientSideToolDiscovery(provider)
  )
}

export function shouldDisableToolDeferralForProvider(
  provider: APIProvider,
  powerMode: PowerMode,
): boolean {
  // Cheap mode never defers, on any provider. Its toolset is already the
  // compact core set — cheap loads no MCP servers, skills, agents, plugins or
  // LSP — so the whole deferrable surface is a few KB, and paying it up front
  // buys three things deferral cannot: the model always has real parameter
  // schemas (weaker cheap-mode models guess worst), the front-of-request tool
  // array never gets rewritten mid-session on client-side lanes, and no turn
  // is ever spent recovering a call whose schema was hidden.
  if (powerMode === 'cheap') return true
  // Same reasoning as cheap mode's third clause, for providers where the
  // front-of-request rewrite is not merely wasteful but cache-fatal.
  if (providerUsesExactPrefixCache(provider)) return true
  if (provider === 'nim' && isNimFastToolFilterActive()) return true
  return !providerSupportsSafeToolDiscovery(provider)
}
