import type { ProviderContentBlock, ProviderMessage, ProviderTool } from '../../services/api/providers/base_provider.js'
import { decodeStatusOf, decodeToolArguments, toolDecodeFields } from '../../services/mcp/decodeStatus.js'
import { isValidAgainstContract } from '../../services/mcp/contractValidation.js'
import { isOutputCapTruncation } from '../shared/truncation.js'
import { restoreOpenRouterOptionalArguments } from '../../utils/model/openrouterStrictSchema.js'
import { OpenRouterReasoningCollector } from './openrouter_reasoning.js'

/** Terminal protocol/loop failures must not trigger another generation fallback. */
export class OpenRouterToolCallError extends Error {
  readonly isRetryable = false
  constructor(message: string) {
    super(`OpenRouter tool-call error: ${message}`)
    this.name = 'OpenRouterToolCallError'
  }
}

const RETRYABLE_CODE = /^(408|429|500|502|503|504|529|server_error|internal_server_error|provider_error|service_unavailable|rate_limit_exceeded)$/i
// The provider says waiting helps: a rate limit or saturated serving capacity.
const CAPACITY = /resource ?exhausted|rate[ _-]?limit|too many requests|overloaded|capacity|request limit|service[ _-]?unavailable|temporarily unavailable/i
// A daily cap resets hours later; no retry inside one turn can clear it.
const DAILY_LIMIT = /per[ _-]?day|daily limit|limit_rpd/i

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500) : ''
}

/** OpenRouter echoes X-RateLimit-Reset (epoch ms) inside error metadata. */
function resetDelayMs(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-ratelimit-reset')
  const reset = Number(entry?.[1])
  if (!Number.isFinite(reset) || reset <= 0) return undefined
  return Math.max(0, (reset < 1e12 ? reset * 1000 : reset) - Date.now())
}

/** A failed upstream generation is distinct from invalid tool arguments.
 * Outer fallback/retry stays disabled; the OpenRouter stream wrapper owns
 * recovery, and only before any assistant output is published.
 */
export class OpenRouterUpstreamError extends OpenRouterToolCallError {
  readonly canRetryBeforeOutput: boolean
  /** Rate limited or out of serving capacity: waiting, not resending, helps. */
  readonly capacity: boolean
  /** How long until the provider's stated limit resets, when it named one. */
  readonly retryAfterMs?: number
  /** Set when OpenRouter rejected the request before streaming anything. */
  readonly status?: number
  /** Tool calls whose arguments were still arriving when generation failed. */
  readonly unfinishedCalls: { name: string; arguments: string }[]
  readonly generation?: string
  readonly provider?: string
  readonly code?: string
  constructor(error: unknown, generation?: string, provider?: string,
    context: { unfinished?: { name?: unknown; arguments?: unknown }[]; retryAfterMs?: number; status?: number } = {}) {
    const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    const metadata = detail.metadata && typeof detail.metadata === 'object'
      ? detail.metadata as Record<string, unknown> : {}
    const code = typeof detail.code === 'number' || typeof detail.code === 'string' ? String(detail.code) : ''
    const message = clean(detail.message) || clean(error) || 'The provider ended generation with an error.'
    super(message)
    this.generation = clean(generation) || undefined
    this.provider = clean(provider) || undefined
    this.code = clean(code) || undefined
    this.name = 'OpenRouterUpstreamError'
    this.unfinishedCalls = (context.unfinished ?? []).flatMap(call => clean(call.name)
      ? [{ name: clean(call.name), arguments: typeof call.arguments === 'string' ? call.arguments.slice(0, 4000) : '' }] : [])
    const pending = [...new Set(this.unfinishedCalls.map(call => call.name))]
    this.message = `OpenRouter upstream error${code ? ` (${clean(code)})` : ''}: ${message}${/[.!?]$/.test(message) ? '' : '.'}` +
      `${provider ? ` Provider: ${clean(provider)}.` : ''}${generation ? ` Generation: ${clean(generation)}.` : ''}` +
      (pending.length ? ` The unfinished ${pending.join(', ')} call${pending.length > 1 ? 's were' : ' was'} discarded; no tool ran.`
        : ' No tool ran.')
    const text = `${message} ${clean(metadata.raw)} ${clean(metadata.limit_source)}`
    this.status = context.status
    this.retryAfterMs = context.retryAfterMs ?? resetDelayMs(metadata.headers)
    this.canRetryBeforeOutput = (!code || RETRYABLE_CODE.test(code)) && !DAILY_LIMIT.test(text)
    this.capacity = this.canRetryBeforeOutput && (/^(429|503|529)$/.test(code) || CAPACITY.test(text))
  }
}

/** An HTTP rejection before any stream. Same retry classification and terminal
 * semantics as an in-stream error; `message` keeps the lane's `openrouter API
 * error NNN` wording, which status parsing and /fallback detection read.
 */
export function openRouterHttpError(
  status: number, body: string, headers: Headers | undefined, message: string,
): OpenRouterUpstreamError {
  let detail: Record<string, unknown> = {}
  try {
    const parsed = (JSON.parse(body) as { error?: unknown })?.error
    if (parsed && typeof parsed === 'object') detail = parsed as Record<string, unknown>
  } catch { /* plain-text body */ }
  const metadata = detail.metadata && typeof detail.metadata === 'object'
    ? detail.metadata as Record<string, unknown> : {}
  const header = headers?.get('retry-after')?.trim()
  const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : undefined
  const date = header && seconds === undefined ? Date.parse(header) - Date.now() : undefined
  const error = new OpenRouterUpstreamError({ ...detail, message: detail.message ?? body, code: detail.code ?? status },
    undefined, typeof metadata.provider_name === 'string' ? metadata.provider_name : undefined,
    { status, retryAfterMs: seconds ?? (Number.isFinite(date) ? Math.max(0, date!) : undefined) })
  error.message = message
  return error
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  })
}

/** Uses recorded tool outcomes and the declared schema, never tool-specific
 * repairs. Successful tools supply fresh state for execution failures, but an
 * unrelated success cannot fix a malformed call or teach a missing parameter.
 * Corrected arguments are allowed; a third uncorrected failure is terminal.
 */
export function assertOpenRouterToolProgress(
  messages: ProviderMessage[],
  tools: ProviderTool[],
  name: string,
  raw: unknown,
): void {
  const calls = new Map<string, ProviderContentBlock>()
  const failed: ProviderContentBlock[] = []
  const contractFailures: ProviderContentBlock[] = []
  const schema = tools.find(tool => tool.name === name)?.input_schema
  const invalid = (input: unknown) => schema && isValidAgainstContract(schema, input) === false
  const reset = () => { failed.length = 0; contractFailures.length = 0 }
  for (const message of messages) {
    if (typeof message.content === 'string') {
      if (message.role === 'user') reset()
      continue
    }
    const hasResult = message.content.some(block => block.type === 'tool_result')
    if (message.role === 'user' && !hasResult && message.content.some(block => block.type === 'text')) {
      reset()
    }
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) calls.set(block.id, block)
      if (block.type !== 'tool_result') continue
      const call = calls.get(block.tool_use_id ?? '')
      if (block.is_error !== true) {
        failed.length = 0
        if (call?.name === name) contractFailures.length = 0
        continue
      }
      if (call?.name === name) {
        failed.push(call)
        if (decodeStatusOf(call) || invalid(call.input)) contractFailures.push(call)
      }
    }
  }
  const decoded = decodeToolArguments(raw)
  const valid = (input: unknown) => schema && isValidAgainstContract(schema, input) === true
  const recent = failed.slice(-2)
  const repeated = ((decoded.status || invalid(decoded.input)) && contractFailures.length >= 2) ||
    (!decoded.status && failed.length >= 2 && (
      recent.every(call => !decodeStatusOf(call) && canonical(call.input) === canonical(decoded.input)) ||
      // Changing syntactically valid arguments after repeated execution
      // failures is not evidence about file contents or external state.
      // Require a successful tool result before a third speculative attempt.
      (valid(decoded.input) && recent.every(call => !decodeStatusOf(call) && valid(call.input)))
    ))
  if (repeated) {
    throw new OpenRouterToolCallError(
      `${name} failed twice without verified progress. ` +
      'Stopped before dispatching this batch. Correct invalid arguments using the declared schema; for execution errors, inspect current state and previous tool results before retrying.',
    )
  }
}

type Call = { index: number; id: string; type: 'function'; function: { name: string; arguments: string } }

/** Chat Completions provides a choice-level finish, not per-call completion.
 * Hold the whole tool batch until that finish. On truncation NONE of its calls
 * can be certified complete, even if a router closed their JSON objects.
 */
export class OpenRouterToolStream {
  private calls = new Map<number, Call>()
  private finished = false
  private generation?: string
  private provider?: string
  private reasoning = new OpenRouterReasoningCollector()
  constructor(private messages: ProviderMessage[], private tools: ProviderTool[], private originals = tools,
    private complete = false) {}

  private decoded(call: Call) {
    const decoded = decodeToolArguments(call.function.arguments)
    const original = this.originals.find(tool => tool.name === call.function.name)?.input_schema
    const advertised = this.tools.find(tool => tool.name === call.function.name)?.input_schema
    if (!decoded.status && original && advertised) {
      decoded.input = restoreOpenRouterOptionalArguments(decoded.input, original, advertised) as Record<string, unknown>
    }
    return decoded
  }

  accept(chunk: any): any {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
      throw new OpenRouterToolCallError('The stream contained an invalid completion event.')
    }
    if (typeof chunk.id === 'string' && chunk.id) this.generation = chunk.id
    if (typeof chunk.provider === 'string' && chunk.provider) this.provider = chunk.provider
    const choice = chunk.choices?.[0]
    if (chunk.error || choice?.error || choice?.finish_reason === 'error' || choice?.native_finish_reason === 'error') {
      const unfinished = [...this.calls.values(), ...(Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [])]
      this.calls.clear()
      throw new OpenRouterUpstreamError(chunk.error ?? choice?.error, this.generation, this.provider,
        { unfinished: unfinished.map(call => ({ name: call?.function?.name, arguments: call?.function?.arguments })) })
    }
    if (!choice) return chunk
    const delta = choice.delta ?? {}
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) {
      throw new OpenRouterToolCallError('Tool fragments must arrive as an indexed array.')
    }
    if (this.finished) {
      if (delta.tool_calls?.length) {
        throw new OpenRouterToolCallError('Tool fragments arrived after the completion boundary.')
      }
      return { ...chunk, choices: [{ ...choice, finish_reason: null }] }
    }
    this.reasoning.accept(delta, this.complete)
    for (const fragment of delta.tool_calls ?? []) {
      const index = fragment?.index
      if (!Number.isInteger(index) || index < 0) {
        throw new OpenRouterToolCallError('A tool fragment has no valid index; its destination is ambiguous.')
      }
      if ((fragment.id != null && typeof fragment.id !== 'string') ||
        (fragment.function?.name != null && typeof fragment.function.name !== 'string')) {
        throw new OpenRouterToolCallError('Tool identifiers and function names must be strings.')
      }
      let call = this.calls.get(index)
      if (!call) {
        call = { index, id: '', type: 'function', function: { name: '', arguments: '' } }
        this.calls.set(index, call)
      }
      if (fragment.id) {
        if (call.id && call.id !== fragment.id) throw new OpenRouterToolCallError('A tool index changed call IDs mid-stream.')
        call.id = fragment.id
      }
      if (fragment.function?.name) {
        if (call.function.name && call.function.name !== fragment.function.name) {
          throw new OpenRouterToolCallError('A tool index changed function names mid-stream.')
        }
        call.function.name = fragment.function.name
      }
      const args = fragment.function?.arguments
      if (args !== undefined && args !== null) {
        if (typeof args !== 'string') throw new OpenRouterToolCallError('Tool argument deltas must be JSON text.')
        call.function.arguments += args
      }
    }
    const nextDelta = { ...delta }
    // OpenRouter's documented plaintext field is `reasoning`. The legacy
    // adapter consumes reasoning_content; normalize only on this provider.
    if (typeof delta.reasoning === 'string' && delta.reasoning_content == null) {
      nextDelta.reasoning_content = delta.reasoning
    }
    delete nextDelta.tool_calls
    const reason = isOutputCapTruncation(choice.finish_reason) || isOutputCapTruncation(choice.native_finish_reason)
      ? 'length' : choice.finish_reason ?? choice.native_finish_reason
    if (reason) {
      this.finished = true
      if (isOutputCapTruncation(reason)) {
        this.calls.clear()
      } else if (this.calls.size) {
        if (reason !== 'tool_calls' && reason !== 'stop') {
          throw new OpenRouterToolCallError(`The upstream ended a tool batch with ${String(reason)}; no calls were dispatched.`)
        }
        const calls = [...this.calls.values()].sort((a, b) => a.index - b.index)
        const ids = new Set<string>()
        const validationHistory = [...this.messages]
        for (const call of calls) {
          if (!call.id || !call.function.name || ids.has(call.id)) {
            throw new OpenRouterToolCallError('A completed tool batch has missing or duplicate call identifiers.')
          }
          ids.add(call.id)
          const tool = this.tools.find(tool => tool.name === call.function.name)
          if (!tool) {
            throw new OpenRouterToolCallError(
              `${call.function.name} was not declared on this request. No calls in this batch were dispatched.`,
            )
          }
          const decoded = this.decoded(call)
          assertOpenRouterToolProgress(validationHistory, this.originals, call.function.name,
            decoded.status ? call.function.arguments : decoded.input)
          const original = this.originals.find(tool => tool.name === call.function.name) ?? tool
          if (decoded.status || isValidAgainstContract(original.input_schema, decoded.input) === false) {
            // Model-generated batches can repeat the same contract error before
            // the executor records any results. Count those known failures too,
            // without mutating conversation history or repairing arguments.
            validationHistory.push(
              { role: 'assistant', content: [{ type: 'tool_use', id: call.id,
                name: call.function.name, input: decoded.input, ...toolDecodeFields(decoded) }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: '' }] },
            )
          }
        }
        const reasoning = this.reasoning.snapshot()
        nextDelta.tool_calls = calls.map((call, index) => {
          const decoded = this.decoded(call)
          return { ...call, ...toolDecodeFields(decoded),
            ...(index === 0 && reasoning && { _openrouter_reasoning: reasoning }), function: { ...call.function,
            arguments: JSON.stringify(decoded.input),
          } }
        })
        this.calls.clear()
      }
    }
    return { ...chunk, choices: [{ ...choice, delta: nextDelta, finish_reason: reason ?? null }] }
  }

  end(): void {
    if (!this.finished && this.calls.size) {
      throw new OpenRouterToolCallError('The stream ended before the tool batch completed. No pending tools were dispatched.')
    }
  }
}

export async function* guardOpenRouterToolStream<T>(
  stream: AsyncIterable<T>, messages: ProviderMessage[], tools: ProviderTool[], originals = tools, complete = false,
): AsyncGenerator<T> {
  const guard = new OpenRouterToolStream(messages, tools, originals, complete)
  for await (const chunk of stream) yield guard.accept(chunk)
  guard.end()
}
