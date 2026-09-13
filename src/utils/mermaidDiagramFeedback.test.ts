import { describe, expect, test } from 'bun:test'
import { getUndrawnMermaidReasons } from './mermaidDiagramFeedback.js'

const FENCE = '```'
const human = (text = 'hi') => ({ type: 'user', message: { content: text } })
const toolResult = { type: 'user', toolUseResult: {}, message: { content: [] } }
const meta = { type: 'user', isMeta: true, message: { content: 'reminder' } }
const note = { type: 'attachment', attachment: { type: 'mermaid_not_drawn' } }
const reply = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const block = (source: string) => `Here:\n\n${FENCE}mermaid\n${source}\n${FENCE}\n`
const wide =
  'flowchart LR\n' +
  Array.from(
    { length: 8 },
    (_, i) => `  N${i}[Step number ${i} of it] --> N${i + 1}[Step number ${i + 1} of it]`,
  ).join('\n')
const pie = 'pie\n  "a" : 1'

describe('getUndrawnMermaidReasons', () => {
  test('says nothing when every diagram was drawn', () => {
    expect(getUndrawnMermaidReasons([human(), reply(block('flowchart TD\n  A --> B'))], 120)).toEqual([])
    expect(getUndrawnMermaidReasons([human(), reply(block(wide))], 120)).toEqual([])
  })

  // Turned top-down, `wide` fits 40 columns; neither way fits 20.
  test('explains a diagram too wide for the terminal', () => {
    const reasons = getUndrawnMermaidReasons([human(), reply(block(wide))], 20)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/^it needs \d+ columns and the terminal has 20$/)
  })

  test('looks only at replies since the last human turn', () => {
    expect(getUndrawnMermaidReasons([human(), reply(block(pie)), human()], 120)).toEqual([])
  })

  test('reads across tool calls and meta messages in the same turn', () => {
    const history = [human(), reply(block(pie)), toolResult, meta, reply('Done.')]
    expect(getUndrawnMermaidReasons(history, 120)).toEqual(['pie diagrams are not supported'])
  })

  test('is sent once: stops at the note already sent', () => {
    expect(getUndrawnMermaidReasons([human(), reply(block(pie)), note], 120)).toEqual([])
  })

  test('finds a diagram behind a glued fence', () => {
    const glued = `Schema:${FENCE}mermaid\n${wide}\n${FENCE}\n`
    expect(getUndrawnMermaidReasons([human(), reply(glued)], 20)).toHaveLength(1)
  })

  test('ignores mermaid outside a top-level fence', () => {
    expect(getUndrawnMermaidReasons([human(), reply('I can draw mermaid diagrams.')], 40)).toEqual([])
    const nested = `- item\n\n  ${FENCE}mermaid\n  ${pie}\n  ${FENCE}\n`
    expect(getUndrawnMermaidReasons([human(), reply(nested)], 40)).toEqual([])
  })

  test('lists each reason once, at most three', () => {
    const history = [
      human(),
      ...['pie', 'gantt', 'mindmap', 'journey', 'pie'].map(kind => reply(block(`${kind}\n  x`))),
    ]
    const reasons = getUndrawnMermaidReasons(history, 120)
    expect(reasons).toHaveLength(3)
    expect(new Set(reasons).size).toBe(3)
  })
})
