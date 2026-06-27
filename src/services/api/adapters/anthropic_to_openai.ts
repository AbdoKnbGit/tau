/**
 * Outbound adapter: Converts Anthropic-format messages → OpenAI Chat Completions format.
 *
 * Used by OpenAI-compatible providers (OpenAI, OpenRouter, Groq, NVIDIA NIM).
 */

import type {
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  SystemBlock,
} from '../providers/base_provider.js'
import { recordToolSchema } from './tool_schema_cache.js'

// ─── OpenAI types (minimal, no SDK dependency) ─────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: string }
  cache_control?: { type: string }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

// ─── Anthropic-field stripping ─────────────────────────────────────

/**
 * Remove Anthropic-specific fields (cache_control, citations, etc.)
 * from content blocks before sending to third-party providers.
 * These fields are not part of the OpenAI API and may cause errors
 * or leak internal implementation details (#276, #268, #258).
 */
function stripAnthropicFields(block: ProviderContentBlock): ProviderContentBlock {
  // Destructure known Anthropic-only fields and return the rest
  const { cache_control, citations, ...clean } = block as ProviderContentBlock & {
    cache_control?: unknown
    citations?: unknown
  }
  return clean
}

function textFromContent(content: ProviderContentBlock['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => c.text ?? '').join('')
}

function imagePartsFromContent(
  content: ProviderContentBlock['content'],
): OpenAIContentPart[] {
  if (!Array.isArray(content)) return []
  return content.flatMap(c =>
    c.type === 'image' && c.source
      ? [{
          type: 'image_url' as const,
          image_url: {
            url: `data:${c.source.media_type};base64,${c.source.data}`,
          },
        }]
      : [],
  )
}

// ─── Message Conversion ────────────────────────────────────────────

export interface AdapterOptions {
  /**
   * Preserve cache_control markers on content blocks.
   * OpenRouter passes these through to underlying providers (Anthropic, etc.)
   * enabling prompt caching and reducing per-request token usage.
   */
  preserveCacheControl?: boolean
}

export function anthropicMessagesToOpenAI(
  messages: ProviderMessage[],
  system?: string | SystemBlock[],
  options?: AdapterOptions,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  const keepCache = options?.preserveCacheControl === true

  // System prompt → system message
  if (system) {
    if (keepCache && Array.isArray(system)) {
      // Preserve cache_control in structured content blocks so providers
      // like OpenRouter can forward them for prompt caching.
      const parts: OpenAIContentPart[] = system.map(s => {
        const block = s as SystemBlock & { cache_control?: { type: string } }
        const part: OpenAIContentPart = { type: 'text', text: block.text }
        if (block.cache_control) {
          part.cache_control = block.cache_control
        }
        return part
      })
      result.push({ role: 'system', content: parts })
    } else {
      const systemText = typeof system === 'string'
        ? system
        : system.map(s => {
            const { cache_control, ...rest } = s as SystemBlock & { cache_control?: unknown }
            return rest.text
          }).join('\n\n')
      if (systemText) {
        result.push({ role: 'system', content: systemText })
      }
    }
  }

  const stripBlock = keepCache
    ? (block: ProviderContentBlock) => {
        // Keep cache_control, strip only other Anthropic-specific fields
        const { citations, ...clean } = block as ProviderContentBlock & { citations?: unknown }
        return clean
      }
    : stripAnthropicFields

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
      continue
    }

    // Content is an array of blocks
    const blocks = (msg.content as ProviderContentBlock[]).map(stripBlock)

    if (msg.role === 'assistant') {
      // Check for tool_use blocks
      const textParts = blocks.filter(b => b.type === 'text')
      const toolUses = blocks.filter(b => b.type === 'tool_use')

      const openAIMsg: OpenAIMessage = { role: 'assistant' }

      if (textParts.length > 0) {
        openAIMsg.content = textParts.map(t => t.text ?? '').join('')
      } else {
        openAIMsg.content = null
      }

      if (toolUses.length > 0) {
        openAIMsg.tool_calls = toolUses.map(t => ({
          id: t.id ?? `call_${Math.random().toString(36).slice(2, 11)}`,
          type: 'function' as const,
          function: {
            name: t.name ?? '',
            arguments: JSON.stringify(t.input ?? {}),
          },
        }))
      }

      result.push(openAIMsg)
    } else {
      // User message — may contain text, tool_results, or images
      const toolResults = blocks.filter(b => b.type === 'tool_result')
      const otherBlocks = blocks.filter(b => b.type !== 'tool_result')

      // Emit tool results as separate 'tool' role messages
      const toolResultImageParts: OpenAIContentPart[] = []
      for (const tr of toolResults) {
        const content = textFromContent(tr.content)
        toolResultImageParts.push(...imagePartsFromContent(tr.content))
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id ?? '',
          content,
        })
      }

      if (toolResultImageParts.length > 0) {
        result.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Visual observation from the previous tool result:',
            },
            ...toolResultImageParts,
          ],
        })
      }

      // Emit remaining content as user message
      if (otherBlocks.length > 0) {
        const hasImages = otherBlocks.some(b => b.type === 'image')
        if (hasImages) {
          // Use OpenAI content parts format for mixed text+images
          const parts: OpenAIContentPart[] = otherBlocks.map(b => {
            if (b.type === 'image' && b.source) {
              return {
                type: 'image_url' as const,
                image_url: {
                  url: `data:${b.source.media_type};base64,${b.source.data}`,
                },
              }
            }
            return { type: 'text' as const, text: b.text ?? '' }
          })
          result.push({ role: 'user', content: parts })
        } else {
          const text = otherBlocks.map(b => b.text ?? '').join('')
          if (text) {
            result.push({ role: 'user', content: text })
          }
        }
      }
    }
  }

  return result
}

/**
 * Coalesce consecutive same-role messages for strict models (e.g. o1-series)
 * that require strictly alternating user/assistant roles.
 * Merges consecutive messages with the same role by joining their text content.
 */
export function coalesceConsecutiveMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= 1) return messages

  const result: OpenAIMessage[] = [messages[0]!]

  for (let i = 1; i < messages.length; i++) {
    const current = messages[i]!
    const prev = result[result.length - 1]!

    // Only coalesce if same role AND neither has tool_calls/tool_call_id
    if (
      current.role === prev.role &&
      !current.tool_calls && !prev.tool_calls &&
      !current.tool_call_id && !prev.tool_call_id
    ) {
      // Merge text content
      const prevText = typeof prev.content === 'string' ? prev.content : ''
      const currText = typeof current.content === 'string' ? current.content : ''
      prev.content = [prevText, currText].filter(Boolean).join('\n\n')
    } else {
      result.push(current)
    }
  }

  return result
}

// ─── Schema Sanitization ──────────────────────────────────────────

/**
 * Fields that many OpenAI-compatible providers do not support in tool schemas.
 * Standard JSON Schema but rejected by Groq, some OpenRouter models, etc.
 * Stripping these avoids 400 errors across the ecosystem.
 */
const UNSUPPORTED_OPENAI_SCHEMA_FIELDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$comment',
])

/**
 * Recursively strip unsupported JSON Schema fields from tool parameter schemas.
 * Returns a new object — does not mutate the original.
 */
export function sanitizeSchemaForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_OPENAI_SCHEMA_FIELDS.has(key)) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([propName, propSchema]) => [
          propName,
          propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
            ? sanitizeSchemaForOpenAI(propSchema as Record<string, unknown>)
            : propSchema,
        ]),
      )
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForOpenAI(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

// ─── Tool Conversion ───────────────────────────────────────────────

export function anthropicToolsToOpenAI(tools: ProviderTool[]): OpenAITool[] {
  return tools.map(t => {
    const parameters = sanitizeSchemaForOpenAI(t.input_schema)
    recordToolSchema(t.name, parameters)
    return {
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters,
      },
    }
  })
}
