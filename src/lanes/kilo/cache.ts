import type {
  OpenAIContentPart,
  OpenAIMessage,
} from '../../services/api/adapters/anthropic_to_openai.js'

/**
 * Kilo prompt-cache breakpoints.
 *
 * Kilo speaks OpenAI Chat Completions to an OpenRouter-style gateway, while
 * prompt caching is ultimately forwarded to Anthropic-style cache_control
 * markers. Keep the rolling markers on user messages only. Tool results are
 * represented as OpenAI `role: "tool"` messages in this lane, and cache markers
 * on that role have proven unstable under tool-heavy loops.
 */
export function applyKiloCacheBreakpoints(messages: OpenAIMessage[]): void {
  const stamp = (parts: OpenAIContentPart[]): void => {
    if (parts.length === 0) return
    const last = parts[parts.length - 1]
    if (last && last.type === 'text' && !last.cache_control) {
      last.cache_control = { type: 'ephemeral' }
    }
  }

  const stampUserMessage = (m: OpenAIMessage): void => {
    if (m.role !== 'user') return
    if (Array.isArray(m.content) && m.content.length > 0) {
      stamp(m.content)
    }
  }

  const sys = messages.find((m) => m.role === 'system')
  if (sys) {
    if (typeof sys.content === 'string') {
      const text = sys.content
      if (text.length > 0) {
        sys.content = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      }
    } else if (Array.isArray(sys.content)) {
      stamp(sys.content)
    }
  }

  // Moving a marker must not change an older user message's wire encoding.
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content || ' ' }]
    }
  }

  let stamped = 0
  for (let i = messages.length - 1; i >= 0 && stamped < 2; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    stampUserMessage(m)
    stamped++
  }
}
