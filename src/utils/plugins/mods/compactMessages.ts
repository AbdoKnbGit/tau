import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Message } from '../../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../messages.js'
import { compactConversationRows } from './sessionMessages.js'

const toolUse = z.object({
  tool_use_id: z.string().min(1), tool: z.string().min(1), input: z.record(z.unknown()),
})
const toolResult = z.object({
  tool_use_id: z.string().min(1), text: z.string(), isError: z.boolean(), result: z.unknown().optional(),
})
const newRow = z.object({
  role: z.enum(['assistant', 'user']), text: z.string(),
  toolUses: z.array(toolUse), toolResults: z.array(toolResult).optional(),
}).strict()
const rowsSchema = z.array(z.union([z.object({ handle: z.string().min(1) }), newRow]))
const tokens = z.number().int().nonnegative()
const usageSchema = z.object({
  input_tokens: tokens, output_tokens: tokens, cache_read_input_tokens: tokens, cache_creation_input_tokens: tokens,
}).strict()
const compactResult = z.union([
  z.object({ skip: z.string().refine(text => text.trim().length > 0) }).strict(),
  z.object({
    messages: rowsSchema, tokensBefore: tokens.optional(), tokensAfter: tokens.optional(), usage: usageSchema.optional(),
  }).strict(),
])
export type CompactReceipt = z.infer<typeof compactResult>
type Rows = z.infer<typeof rowsSchema>

/** What the user sees when a rejected hook left the normal summary in charge. */
export function compactFallbackText(warnings: string[]): string {
  return warnings.join('\n') + '\nA normal summary ran after the invalid session.compact hook.'
}

function buildMessage(row: z.infer<typeof newRow>): Message {
  const text = row.text ? [{ type: 'text' as const, text: row.text }] : []
  if (row.role === 'assistant') {
    return createAssistantMessage({ content: [...text, ...row.toolUses.map(use => ({
      type: 'tool_use' as const, id: use.tool_use_id, name: use.tool, input: use.input,
    }))] })
  }
  const results = row.toolResults ?? []
  return createUserMessage({
    content: [...results.map(result => ({
      type: 'tool_result' as const, tool_use_id: result.tool_use_id,
      content: result.text, is_error: result.isError,
    })), ...text],
    toolUseResult: results.length === 1 ? results[0]!.result : undefined,
  })
}

/** Handles are local to a single compaction. An unchanged list represents the
 * entire native view, including attachments and private provider metadata. */
export class CompactMessageHandles {
  private readonly originals = new Map<string, Message>()
  private readonly handles = new WeakMap<Message, string>()

  expose(messages: Message[]) {
    const rows = compactConversationRows(messages).map(({ message, row }) => {
      let handle = this.handles.get(message)
      if (!handle) {
        handle = randomUUID()
        this.originals.set(handle, message)
        this.handles.set(message, handle)
      }
      return { ...row, handle }
    })
    return { messages, rows }
  }

  check(rows: Rows): void {
    const seen = new Set<Message>()
    for (const row of rows) {
      if ('handle' in row) {
        const message = this.originals.get(row.handle)
        if (!message || seen.has(message)) throw new Error('Unknown or repeated session.compact message handle')
        seen.add(message)
      } else if (row.role === 'user' ? row.toolUses.length : row.toolResults?.length) {
        throw new Error('Invalid tool block for session.compact message role')
      }
    }
  }

  checkInput(input: { messages?: unknown; instructions?: unknown }): void {
    if (input.instructions !== undefined && typeof input.instructions !== 'string') throw new Error('Expected compact instructions to be text')
    this.check(rowsSchema.parse(input.messages))
  }

  result(value: unknown): CompactReceipt {
    const result = compactResult.parse(value)
    if ('messages' in result) this.check(result.messages)
    return result
  }

  restore(rows: Rows, view: ReturnType<CompactMessageHandles['expose']>): Message[] {
    if (rows.length === view.rows.length && rows.every((row, i) => 'handle' in row && row.handle === view.rows[i]!.handle)) {
      return view.messages
    }
    return rows.map(row => 'handle' in row ? this.originals.get(row.handle)! : buildMessage(row))
  }
}
