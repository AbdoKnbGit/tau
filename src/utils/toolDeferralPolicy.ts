import { providerSupportsAnthropicToolSearch } from './model/providerCapabilities.js'
import type { APIProvider } from './model/providers.js'
import type { PowerMode } from './powerMode.js'
import { isSmallTierGroqModel } from '../lanes/openai-compat/groq_tool_policy.js'
import { isNimFastToolFilterActive } from '../lanes/openai-compat/nim_tool_policy.js'
import { isOpenCodeAnthropicRouteModel } from '../lanes/openai-compat/opencode_anthropic_route.js'

/**
 * Providers routed through Tau's Gemini or OpenAI-compatible lanes. These
 * lanes implement tool discovery client-side: undeclared schemas stay in
 * Tau, ToolSearch records the selected names, and the selected schemas are
 * appended on the following request.
 *
 * Keep this list narrower than `isThirdPartyProvider()`. A provider belongs
 * here only when its active lane calls the shared lazy-tool selector. Unknown
 * and dedicated lanes deliberately fall back to eager schemas.
 */
const CLIENT_SIDE_TOOL_DISCOVERY_PROVIDERS: ReadonlySet<APIProvider> = new Set([
  'gemini',
  'openrouter',
  'modelrouter',
  'vercel',
  'requesty',
  'opencode',
  'opencodego',
  'fireworks',
  'cloudflare',
  'groq',
  'mistral',
  'nim',
  'deepseek',
  'glm',
  'moonshot',
  'minimax',
  'ollama',
  'lmstudio',
  'copilot',
  'iflow',
])

export function providerSupportsClientSideToolDiscovery(
  provider: APIProvider,
): boolean {
  return CLIENT_SIDE_TOOL_DISCOVERY_PROVIDERS.has(provider)
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
  // NIM prunes to a fixed fast subset before the lazy selector. Keeping
  // ToolSearch active there would advertise/select schemas the transformer
  // can never send. Full-tools / no-optimize mode bypasses the prune and may
  // use the normal append-only client discovery path.
  if (provider === 'nim' && isNimFastToolFilterActive()) return false
  if (!model) return true

  // Groq's small-tier filter deliberately removes ToolSearch while retaining
  // callable WebSearch/WebFetch/MCP schemas. Treat that final toolset as eager.
  if (provider === 'groq' && isSmallTierGroqModel(model)) return false

  // These rows bypass the OpenAI-compatible selector and use the gateway's
  // Anthropic-format route, where they currently receive eager schemas.
  if (
    (provider === 'opencode' || provider === 'opencodego') &&
    isOpenCodeAnthropicRouteModel(model)
  ) {
    return false
  }

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
  if (provider === 'nim' && isNimFastToolFilterActive()) return true
  return !providerSupportsSafeToolDiscovery(provider)
}
