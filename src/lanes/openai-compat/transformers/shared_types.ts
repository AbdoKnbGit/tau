/**
 * Wire-format types shared between the lane's loop.ts and its per-
 * provider transformers. Keeping them in a separate module breaks a
 * potential circular dep between loop.ts and the transformers.
 */

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null | Array<{ type: string; text?: string; image_url?: unknown }>
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
      strict?: boolean
    }
  }>
  tool_choice?: 'auto' | 'required' | 'none' | 'any' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string[]
  reasoning_effort?: 'low' | 'medium' | 'high'
  reasoning?: { effort?: string }
  thinking?: { type: 'enabled' } | { type: 'disabled' }
  extra_body?: Record<string, unknown>
  transforms?: string[]
  plugins?: Array<{ id: string; enabled?: boolean; [key: string]: unknown }>
  models?: string[]
  route?: string
  session_id?: string
  prompt_cache_key?: string
  prompt_cache_retention?: '24h'
  /** End-user / session identifier. Used by Fireworks as a replica
   *  routing-affinity hint (body-level fallback for x-session-affinity). */
  user?: string
  /** Fireworks: include perf_metrics (incl. cached-prompt-tokens) in the response body. */
  perf_metrics_in_response?: boolean
  providerOptions?: {
    gateway?: {
      caching?: 'auto'
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  requesty?: {
    auto_cache?: boolean
    [key: string]: unknown
  }
}
