/**
 * Groq provider — extends OpenAIProvider.
 *
 * Groq provides ultra-fast inference for open-source models.
 * All models are free with rate limits.
 *
 * Base URL: https://api.groq.com/openai/v1
 * Auth: Bearer token (gsk_...)
 * API: OpenAI-compatible
 *
 * Groq free-tier TPM limits (tokens per minute, INPUT+OUTPUT combined):
 *   qwen/qwen3-32b:               6,000 TPM
 *   llama-3.3-70b-versatile:     12,000 TPM
 *   deepseek-r1-distill-llama-70b: 6,000 TPM
 *   openai/gpt-oss-120b:          6,000 TPM
 *
 * Strategy: send tools with FULL unmodified schemas so Groq's API can
 * enforce proper function-calling format. Stripped schemas cause models
 * to emit malformed calls (<function=Name,{...}> instead of real tool use).
 * We only filter WHICH tools are sent and trim the system prompt.
 */

import { OpenAIProvider } from './openai_provider.js'
import type {
  ProviderConfig,
  ProviderRequestParams,
  ProviderTool,
  SystemBlock,
} from './base_provider.js'

/**
 * Tools that Groq's models can reliably call via OpenAI function-calling.
 * These have simple, well-structured schemas that work with smaller models.
 *
 * NOT included: Agent, TaskCreate, TaskUpdate, EnterPlanMode, NotebookEdit,
 * ToolSearch, MCP tools — their multi-parameter schemas cause small models
 * to output malformed calls and trigger tool_use_failed errors.
 *
 * Users who need the full tool set should use PROVIDER_NO_OPTIMIZE=true
 * with a model that handles complex tool calling (e.g. llama-3.3-70b).
 */
const GROQ_TOOLS = new Set([
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
])

export class GroqProvider extends OpenAIProvider {
  readonly name = 'groq'

  constructor(config: ProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: 'https://api.groq.com/openai/v1',
      extraHeaders: config.extraHeaders,
    })

    // Trim system prompt but not as aggressively as before
    if (!process.env.GROQ_MAX_SYSTEM_CHARS && !process.env.PROVIDER_MAX_SYSTEM_CHARS) {
      this.maxSystemChars = 2000
    }
    if (!process.env.GROQ_MAX_TOKENS && !process.env.PROVIDER_MAX_TOKENS) {
      this.maxTokensCap = 4096
    }
  }

  /**
   * Filter to supported tools with FULL schemas (no stripping).
   * Groq's API needs complete schemas to enforce proper function-calling
   * format. Stripped/mangled schemas cause models to fall back to
   * text-based pseudo-function-calls that trigger 400 errors.
   */
  protected optimizeParams(params: ProviderRequestParams): ProviderRequestParams {
    if (!this.optimizePayload) return params

    // Filter tools to the supported set — keep schemas intact
    let tools: ProviderTool[] | undefined
    if (params.tools && params.tools.length > 0) {
      const filtered = params.tools.filter(t => GROQ_TOOLS.has(t.name))
      tools = filtered.length > 0 ? filtered : undefined
    }

    return {
      ...params,
      system: this._trimSystem(params.system),
      tools,
      max_tokens: Math.min(params.max_tokens, this.maxTokensCap),
    }
  }

  /**
   * Trim system prompt to fit Groq's TPM limits. Keeps the beginning
   * (most important instructions) and appends a note about available tools.
   */
  private _trimSystem(
    system?: string | SystemBlock[],
  ): string | SystemBlock[] | undefined {
    if (!system) return system

    const fullText = typeof system === 'string'
      ? system
      : system.map(s => s.text).join('\n\n')

    if (fullText.length <= this.maxSystemChars) {
      return typeof system === 'string' ? system : system
    }

    // Find a clean cut at a paragraph break
    let cutPoint = this.maxSystemChars
    const lastBreak = fullText.lastIndexOf('\n\n', cutPoint)
    if (lastBreak > this.maxSystemChars * 0.7) {
      cutPoint = lastBreak
    }

    const trimmed = fullText.slice(0, cutPoint) +
      '\n\n[Instructions trimmed. Core tools are listed in this note; any additional tool shown in your current tool list is also callable. ' +
      'ONLY call tools that are in your tool list. Do NOT invent or guess tool names.]'

    if (typeof system === 'string') return trimmed
    return [{ type: 'text' as const, text: trimmed }]
  }
}
