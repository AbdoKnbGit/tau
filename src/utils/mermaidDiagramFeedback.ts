/**
 * Tells the model when a diagram in its latest reply was not drawn, so the
 * next one fits what the terminal can show. The note is a persisted
 * attachment appended after that reply: nothing already sent changes, so the
 * prompt cache is kept, and it is sent once per reply.
 */
import { marked, type Tokens } from 'marked'
import {
  fitMermaidArt,
  isMermaidFence,
  type MermaidFallback,
  normalizeMermaidFences,
} from './mermaidDiagram.js'

type MessageLike = {
  type: string
  isMeta?: boolean
  toolUseResult?: unknown
  attachment?: { type: string }
  message?: { content?: unknown }
}

const MAX_REASONS = 3

/**
 * Why top-level diagrams in the assistant messages since the last human turn
 * (or the last note) were not drawn at `columns`, phrased for the model.
 * Empty when every one was drawn.
 */
export function getUndrawnMermaidReasons(
  messages: readonly MessageLike[],
  columns: number,
): string[] {
  const reasons = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'attachment' &&
      message.attachment?.type === 'mermaid_not_drawn'
    ) {
      break
    }
    // A human turn, as isHumanTurn tells it apart from tool results.
    if (
      message.type === 'user' &&
      !message.isMeta &&
      message.toolUseResult === undefined
    ) {
      break
    }
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const source of mermaidBlocks(block.text)) {
        const drawing = fitMermaidArt(source, columns)
        if (drawing.art === null) reasons.add(explain(drawing.fallback))
      }
    }
  }
  return [...reasons].slice(0, MAX_REASONS)
}

// The top-level mermaid blocks of a reply, found the way <Markdown> finds them.
function mermaidBlocks(text: string): string[] {
  if (!/mermaid/i.test(text)) return []
  const blocks: string[] = []
  for (const token of marked.lexer(normalizeMermaidFences(text))) {
    if (token.type === 'code' && isMermaidFence((token as Tokens.Code).lang)) {
      blocks.push((token as Tokens.Code).text)
    }
  }
  return blocks
}

function explain(fallback: MermaidFallback): string {
  switch (fallback.kind) {
    case 'too-wide':
      return `it needs ${fallback.columnsNeeded} columns and the terminal has ${fallback.columns}`
    case 'too-large':
      return 'it is too long'
    case 'unsupported':
      return fallback.name === null
        ? 'that kind of diagram is not supported'
        : `${fallback.name} diagrams are not supported`
    case 'unreadable':
      return 'it has a mermaid syntax error'
    case 'characters':
      return 'its labels use characters the terminal cannot line up'
  }
}
