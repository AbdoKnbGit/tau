/**
 * Projects the REPL's Message[] into the shape the phone renders.
 *
 * Extraction mirrors useWhatsAppMirror (same content-block walk, same
 * local-command tag handling) but keeps far more: user turns, thinking,
 * per-tool argument detail, and tool results keyed back to their call. A
 * phone showing only "⚙ Bash" tells you nothing — showing the command it is
 * about to run is the difference between watching and actually supervising.
 */

import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import { internImage } from './images.js'
import type { Message } from '../../types/message.js'

export type RemoteItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'sys'; text: string }
  | { kind: 'tool'; id: string; name: string; detail: string }
  | { kind: 'result'; id: string; ok: boolean; text: string }
  | { kind: 'image'; id: string; mediaType: string }

const MAX_TEXT_CHARS = 6000
/** Results are reference material on a phone, not reading material. */
const MAX_RESULT_CHARS = 1200
const MAX_DETAIL_CHARS = 400

function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… +${text.length - limit} more chars`
}

function blocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content)
    ? (content.filter(b => b && typeof b === 'object') as Record<string, unknown>[])
    : []
}

/**
 * Interns any image blocks and returns them as items. Screenshots and pasted
 * images are often the whole point of a turn, so a phone that renders "[image]"
 * is not actually mirroring the session.
 */
function imagesOf(content: unknown): RemoteItem[] {
  const out: RemoteItem[] = []
  for (const block of blocks(content)) {
    if (block.type !== 'image') continue
    const source = block.source as Record<string, unknown> | undefined
    if (!source || source.type !== 'base64') continue
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    const data = typeof source.data === 'string' ? source.data : ''
    const id = internImage(mediaType, data)
    if (id) out.push({ kind: 'image', id, mediaType })
  }
  return out
}

function textOf(content: unknown): string | null {
  if (!content) return null
  if (typeof content === 'string') return content.trim() || null
  const parts: string[] = []
  for (const block of blocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}

function thinkingOf(content: unknown): string | null {
  const parts: string[] = []
  for (const block of blocks(content)) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push(block.thinking)
    }
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}

/**
 * The one argument that actually identifies what a call will do. Falling back
 * to "first short string field" keeps unknown and MCP tools useful instead of
 * rendering a bare name.
 */
export function toolDetail(name: string, input: unknown): string {
  const arg = (input ?? {}) as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof arg[key] === 'string' && arg[key] ? (arg[key] as string) : null

  const direct =
    name === 'Bash'
      ? str('command')
      : name === 'Grep'
        ? [str('pattern'), str('path') ? `in ${str('path')}` : null].filter(Boolean).join(' ')
        : name === 'Glob'
          ? str('pattern')
          : name === 'Task'
            ? str('description')
            : name === 'WebFetch'
              ? str('url')
              : name === 'WebSearch'
                ? str('query')
                : name === 'Skill'
                  ? str('skill')
                  : str('file_path') ?? str('path') ?? str('notebook_path')

  if (direct) return truncate(direct, MAX_DETAIL_CHARS)

  for (const value of Object.values(arg)) {
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.trim(), MAX_DETAIL_CHARS)
    }
  }
  return ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of blocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    // Images are surfaced as their own items; no placeholder needed here.
  }
  return parts.join('\n')
}

function tagContent(content: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`).exec(content)
  return match?.[1]?.trim() || null
}

function localCommandOutput(content: string): string | null {
  return (
    tagContent(content, LOCAL_COMMAND_STDOUT_TAG) ??
    tagContent(content, LOCAL_COMMAND_STDERR_TAG)
  )
}

/** One message can yield thinking, several tool calls, and text. */
export function projectMessage(msg: Message): RemoteItem[] {
  if (msg.type === 'assistant') {
    const out: RemoteItem[] = []

    const thinking = thinkingOf(msg.message?.content)
    if (thinking) out.push({ kind: 'thinking', text: truncate(thinking, MAX_TEXT_CHARS) })

    const text = textOf(msg.message?.content)
    if (text) out.push({ kind: 'assistant', text: truncate(text, MAX_TEXT_CHARS) })

    out.push(...imagesOf(msg.message?.content))

    for (const block of blocks(msg.message?.content)) {
      if (block.type !== 'tool_use') continue
      const name = typeof block.name === 'string' ? block.name : 'tool'
      out.push({
        kind: 'tool',
        id: typeof block.id === 'string' ? block.id : '',
        name,
        detail: toolDetail(name, block.input),
      })
    }
    return out
  }

  if (msg.type === 'system' && msg.subtype === 'local_command') {
    const output = localCommandOutput(msg.content)
    return output ? [{ kind: 'sys', text: truncate(output, MAX_TEXT_CHARS) }] : []
  }

  if (msg.type === 'user') {
    const results: RemoteItem[] = []
    for (const block of blocks(msg.message?.content)) {
      if (block.type !== 'tool_result') continue
      const text = resultText(block.content).trim()
      results.push({
        kind: 'result',
        id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
        ok: block.is_error !== true,
        text: truncate(text, MAX_RESULT_CHARS),
      })
      // A screenshot tool returns its image inside the result content.
      results.push(...imagesOf(block.content))
    }
    if (results.length > 0) return results

    // Images are collected before the text early-outs — a turn that is only a
    // pasted screenshot has no text, and dropping it would lose the message.
    const images = msg.isMeta ? [] : imagesOf(msg.message?.content)
    const text = textOf(msg.message?.content)
    if (!text) return images

    const output = localCommandOutput(text)
    if (output) return [{ kind: 'sys', text: truncate(output, MAX_TEXT_CHARS) }]
    // Meta prompts are model-visible but hidden in the TUI; keep them hidden here.
    if (msg.isMeta) return []
    return [{ kind: 'user', text: truncate(text, MAX_TEXT_CHARS) }, ...images]
  }

  return []
}

export function projectAll(messages: readonly Message[]): RemoteItem[] {
  const out: RemoteItem[] = []
  for (const msg of messages) {
    if (msg) out.push(...projectMessage(msg))
  }
  return out
}
