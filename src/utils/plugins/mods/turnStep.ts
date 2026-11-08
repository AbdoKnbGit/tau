import type { AssistantMessage } from '../../../types/message.js'
import { createAssistantMessage } from '../../messages.js'
import { parseUserSpecifiedModel } from '../../model/model.js'
import { dispatchModStream } from './manager.js'
import { takeModTurnStep } from './lifecycle.js'
import { withModToolContext } from './toolContext.js'

type ModRecord = Record<string, any>
/** What the engine's model stream yields: stream events, the response's
 * blocks as assistant messages, retries, errors. */
type Item = any
type CallModel = (params: any) => AsyncIterable<Item>

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return undefined
  }
}

/**
 * One model request of a turn as `turn.step`, the mods' hooks streaming its
 * response: each may rewrite or drop what streams, send another model or
 * effort, or answer without the model. What leaves the outermost hook is
 * what streams to the person and what the transcript records. Without a
 * step to belong to (a query outside an observed turn) it is the request.
 */
export async function* streamModTurnStep(
  params: { messages: unknown[]; signal: AbortSignal; options: ModRecord },
  callModel: CallModel,
  controller: AbortController,
): AsyncGenerator<Item> {
  const step = takeModTurnStep(controller, typeof params.options.agentId === 'string' ? params.options.agentId : undefined)
  if (!step) {
    yield* callModel(params)
    return
  }
  const agentId: string | undefined = step.context.agentId
  const effort = params.options.effortValue
  const input: ModRecord = {
    turnId: step.turnId,
    index: step.index,
    model: String(params.options.model),
    ...(typeof effort === 'string' || typeof effort === 'number' ? { effort } : {}),
    messageCount: params.messages.length,
    ...(agentId ? { agentId } : {}),
  }

  // The engine's side: every item it streamed by its ref, the chunk each was
  // sent as, and its blocks as they built up.
  const refs: Item[] = []
  const sent = new Map<number, ModRecord>()
  type Block = { type: string; text: string; json: string; id?: string; name?: string }
  const blocks = new Map<number, Block>()
  const assistants: Array<{ ref: number; item: AssistantMessage; index?: number }> = []
  const serverToolUses: ModRecord[] = []
  let currentIndex: number | undefined
  let lastAssistant: AssistantMessage | undefined
  let stopReason: string | null = null
  const chunkOf = (item: Item, ref: number): ModRecord => {
    if (item?.type === 'stream_event') {
      const event = item.event
      if (event?.type === 'content_block_start' && Number.isInteger(event.index)) {
        currentIndex = event.index
        const block = event.content_block ?? {}
        blocks.set(event.index, { type: String(block.type), text: '', json: '', id: block.id, name: block.name })
        if (block.type === 'tool_use') return { kind: 'tool', index: event.index, id: String(block.id), name: String(block.name), ref }
      }
      if (event?.type === 'content_block_delta' && Number.isInteger(event.index)) {
        const delta = event.delta ?? {}
        const block = blocks.get(event.index)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (block) block.text += delta.text
          return { kind: 'text', index: event.index, text: delta.text, ref }
        }
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string')
          return { kind: 'thinking', index: event.index, text: delta.thinking, ref }
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block) block.json += delta.partial_json
          return { kind: 'input', index: event.index, json: delta.partial_json, ref }
        }
      }
      if (event?.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? null
        return { kind: 'stop', stopReason, usage: usageOf(), ref }
      }
    }
    if (item?.type === 'assistant') {
      const message = item as AssistantMessage
      // A block's own message, not an error the engine wrote about it.
      const first = (message.message?.content as ModRecord[] | undefined)?.[0]
      const index = !message.isApiErrorMessage && currentIndex !== undefined && first && blocks.get(currentIndex)?.type === first.type
        ? currentIndex
        : undefined
      assistants.push({ ref, item: message, index })
      if (!message.isApiErrorMessage) lastAssistant = message
      for (const block of (message.message?.content ?? []) as ModRecord[]) {
        if (block.type === 'server_tool_use')
          serverToolUses.push({ id: String(block.id), name: String(block.name), input: block.input, startedAt: Date.now() })
        else if (typeof block.tool_use_id === 'string') {
          const use = serverToolUses.find(item => item.id === block.tool_use_id)
          if (use && use.endedAt === undefined) use.endedAt = Date.now()
        }
      }
    }
    return { kind: 'engine', ref }
  }
  function usageOf(): ModRecord | null {
    const usage = lastAssistant?.message?.usage as ModRecord | undefined
    if (!usage) return null
    const count = (key: string) => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : 0)
    return {
      input_tokens: count('input_tokens'),
      output_tokens: count('output_tokens'),
      cache_read_input_tokens: count('cache_read_input_tokens'),
      cache_creation_input_tokens: count('cache_creation_input_tokens'),
      model: String(lastAssistant?.message?.model ?? params.options.model),
    }
  }
  // The step's result as the engine streamed it.
  const engineResult = (): ModRecord => ({
    turnId: step.turnId,
    index: step.index,
    answer: [...blocks.values()].filter(block => block.type === 'text').map(block => block.text).join(''),
    toolUses: assistants.flatMap(({ item }) => ((item.message?.content ?? []) as ModRecord[])
      .filter(block => block.type === 'tool_use').map(block => ({ name: String(block.name), input: block.input }))),
    ...(serverToolUses.length ? { serverToolUses: serverToolUses.map(item => ({ ...item })) } : {}),
    stopReason: stopReason ?? (lastAssistant?.message?.stop_reason as string | null | undefined) ?? null,
    usage: usageOf(),
  })
  // A hook that answered alone and returned nothing: its chunks are the answer.
  const resultOf = (chunks: unknown[]): ModRecord => {
    let answer = ''
    let reason: string | null = null
    const tools = new Map<number, { name: string; json: string }>()
    for (const chunk of chunks as ModRecord[]) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.kind === 'text' && typeof chunk.text === 'string') answer += chunk.text
      if (chunk.kind === 'tool') tools.set(Number(chunk.index) || 0, { name: String(chunk.name), json: '' })
      if (chunk.kind === 'input') {
        const tool = tools.get(Number(chunk.index) || 0)
        if (tool && typeof chunk.json === 'string') tool.json += chunk.json
      }
      if (chunk.kind === 'stop') reason = chunk.stopReason ?? null
    }
    return {
      turnId: step.turnId, index: step.index, answer,
      toolUses: [...tools.values()].map(tool => ({ name: tool.name, input: parseJson(tool.json) ?? {} })),
      stopReason: reason, usage: null,
    }
  }
  const core = async (e: ModRecord, sink: (chunk: unknown) => void, signal: AbortSignal | undefined) => {
    const model = e.model === input.model ? params.options.model : parseUserSpecifiedModel(String(e.model))
    const request = {
      ...params,
      signal: signal ? AbortSignal.any([params.signal, signal]) : params.signal,
      options: { ...params.options, model, ...(e.effort !== input.effort ? { effortValue: e.effort } : {}) },
    }
    for await (const item of callModel(request)) {
      const ref = refs.push(item) - 1
      const chunk = chunkOf(item, ref)
      sent.set(ref, chunk)
      sink({ ...chunk })
    }
    return engineResult()
  }

  // The person's side: what came out of the outermost hook.
  const passed = new Set<number>()
  const emittedText = new Map<number, string>()
  const emittedTools = new Map<number, { id: string; name: string }>()
  const emittedJson = new Map<number, string>()
  type Made = { type: 'text' | 'tool_use'; text: string; json: string; id?: string; name?: string }
  const made = new Map<string, Made>()
  const withDelta = (item: Item, patch: ModRecord) => ({ ...item, event: { ...item.event, delta: { ...item.event.delta, ...patch } } })
  const translate = (raw: unknown): Item[] => {
    if (!raw || typeof raw !== 'object') return []
    const chunk = raw as ModRecord
    const ref = Number.isInteger(chunk.ref) ? (chunk.ref as number) : undefined
    const original = ref !== undefined ? sent.get(ref) : undefined
    if (ref !== undefined && original && original.kind === chunk.kind) {
      const item = refs[ref]
      passed.add(ref)
      switch (chunk.kind) {
        case 'engine':
          // A block's message waits for the step's end, when what came out
          // of it is known.
          return item?.type === 'assistant' ? [] : [item]
        case 'text': {
          const text = typeof chunk.text === 'string' ? chunk.text : ''
          emittedText.set(original.index, (emittedText.get(original.index) ?? '') + text)
          return text === original.text ? [item] : text ? [withDelta(item, { text })] : []
        }
        case 'thinking': {
          const text = typeof chunk.text === 'string' ? chunk.text : ''
          return text === original.text ? [item] : text ? [withDelta(item, { thinking: text })] : []
        }
        case 'tool': {
          const id = typeof chunk.id === 'string' && chunk.id ? chunk.id : original.id
          const name = typeof chunk.name === 'string' && chunk.name ? chunk.name : original.name
          emittedTools.set(original.index, { id, name })
          return id === original.id && name === original.name
            ? [item]
            : [{ ...item, event: { ...item.event, content_block: { ...item.event.content_block, id, name } } }]
        }
        case 'input': {
          const json = typeof chunk.json === 'string' ? chunk.json : ''
          emittedJson.set(original.index, (emittedJson.get(original.index) ?? '') + json)
          return json === original.json ? [item] : json ? [withDelta(item, { partial_json: json })] : []
        }
        case 'stop':
          return [item]
      }
      return []
    }
    // A chunk a hook made: text on the engine's text block of that index,
    // else blocks of its own, recorded when the step ends.
    const index = Number.isInteger(chunk.index) ? (chunk.index as number) : 0
    if (chunk.kind === 'text' && typeof chunk.text === 'string' && chunk.text) {
      if (blocks.get(index)?.type === 'text') {
        emittedText.set(index, (emittedText.get(index) ?? '') + chunk.text)
        return [{ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk.text } } }]
      }
      const key = `text:${index}`
      const block = made.get(key) ?? { type: 'text' as const, text: '', json: '' }
      block.text += chunk.text
      made.set(key, block)
      return []
    }
    if (chunk.kind === 'tool' && typeof chunk.name === 'string' && chunk.name) {
      made.set(`tool:${index}`, {
        type: 'tool_use', text: '', json: '', name: chunk.name,
        id: typeof chunk.id === 'string' && chunk.id ? chunk.id : `toolu_mod_${step.turnId.slice(0, 8)}_${step.index}_${index}`,
      })
      return []
    }
    if (chunk.kind === 'input' && typeof chunk.json === 'string') {
      const block = made.get(`tool:${index}`)
      if (block) block.json += chunk.json
    }
    return []
  }
  // The step's recorded messages: each block of the engine's whose content
  // came out (its text as it came out), then the blocks hooks made. The
  // response's final usage rides its last kept message.
  const finish = (): Item[] => {
    const items: Item[] = []
    let lastKept: AssistantMessage | undefined
    let lastEngine: AssistantMessage | undefined
    for (const { ref, item, index } of assistants) {
      if (!item.isApiErrorMessage) lastEngine = item
      const block = (item.message?.content as ModRecord[] | undefined)?.[0]
      if (index === undefined || !block) {
        if (passed.has(ref)) { items.push(item); if (!item.isApiErrorMessage) lastKept = item }
        continue
      }
      if (block.type === 'text') {
        // Every chunk dropped, or the text rewritten to nothing: no block (an
        // empty text block is one the API refuses on the next request).
        const text = emittedText.get(index)
        const original = blocks.get(index)?.text ?? ''
        if (text === undefined ? original !== '' || !passed.has(ref) : text === '') continue
        if (text !== undefined && text !== original) block.text = text
      } else if (block.type === 'tool_use') {
        const tool = emittedTools.get(index)
        if (!tool) continue
        block.id = tool.id
        block.name = tool.name
        const json = emittedJson.get(index) ?? ''
        if (json !== (blocks.get(index)?.json ?? '')) block.input = parseJson(json) ?? {}
      } else if (!passed.has(ref)) continue
      items.push(item)
      lastKept = item
    }
    for (const block of made.values()) {
      if (block.type === 'text' && !block.text) continue
      const content = block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'tool_use', id: block.id, name: block.name, input: parseJson(block.json) ?? {} }
      const message = createAssistantMessage({ content: [content as never] })
      items.push(message)
      lastKept = message
    }
    if (lastKept && lastEngine && lastKept !== lastEngine && lastEngine.message?.usage) {
      lastKept.message.usage = lastEngine.message.usage
      lastKept.message.stop_reason = lastEngine.message.stop_reason
    }
    return items
  }

  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let finished = false
  let failure: unknown
  const stop = new AbortController()
  const done = withModToolContext(
    { toolUseContext: step.context, canUseTool: step.canUseTool, assistantMessage: createAssistantMessage({ content: [] }) },
    () => dispatchModStream('turn.step', input, core, chunk => { queue.push(chunk); wake?.() },
      AbortSignal.any([params.signal, stop.signal]), {
        resultOf,
        validateResult: result => {
          if (result.turnId !== input.turnId || result.index !== input.index)
            throw new Error('turn.step cannot rewrite turnId or index')
        },
      }),
  )
  done.then(() => { finished = true; wake?.() }, error => { failure = error; finished = true; wake?.() })
  try {
    while (true) {
      while (queue.length) for (const item of translate(queue.shift())) yield item
      if (finished) break
      await new Promise<void>(resolve => { wake = resolve })
      wake = undefined
    }
    while (queue.length) for (const item of translate(queue.shift())) yield item
    for (const item of finish()) yield item
    if (failure !== undefined) throw failure
  } finally {
    // The query stopped reading: the chain and its request stop too.
    if (!finished) stop.abort(new Error('the query stopped reading the step'))
  }
}
