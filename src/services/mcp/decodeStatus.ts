/**
 * Decode status for a tool call, carried on the tool_use block.
 *
 * When a lane decoder cannot parse a call's streamed arguments — a truncated
 * concatenation, a malformed fragment — it must say so in a way the executor
 * still sees. Otherwise whatever earlier deltas assembled is dispatched as
 * though it were the whole call, and an argument the stream never finished
 * delivering simply goes missing. Validation cannot recover that: a missing
 * optional field is indistinguishable from the model choosing to omit it,
 * and the fragment that did arrive can satisfy the schema on its own.
 *
 * The status lives on the block rather than inside `input`, for two reasons
 * found by putting it in `input` first:
 *
 * - A native adapter builds a fresh argument object from the fields it maps
 *   (`lanes/gemini/tools.ts: adaptInput`), so anything else in there is
 *   dropped and the failure is silently forgotten. Blocks are spread through
 *   the message pipeline, and `input` is the part that gets replaced, so the
 *   envelope is the one place adaptation cannot lose.
 * - Reserving a parameter name means an MCP server that genuinely declares
 *   one is broken by the runtime. A server's arguments are its own.
 *
 * Status is set by trusted runtime processing only. `decodeStatusOf` reads
 * the block and never the arguments, so a model emitting a field of this
 * name cannot claim a decode failure — or, more importantly, cannot clear
 * one.
 */

/** Envelope key. Namespaced like `_gemini_thought_signature` alongside it. */
export const TOOL_DECODE_STATUS_KEY = '_tau_decode_status'

export type ToolDecodeFailureCategory =
  | 'missing'
  /** The streamed JSON ended mid-value. */
  | 'truncated'
  /** JSON could not be parsed; the parser alone cannot establish truncation. */
  | 'malformed'
  /** Parsed, but the root was not the object shape the route requires. */
  | 'invalid_root'

export type ToolDecodeStatus = {
  category: ToolDecodeFailureCategory
  /**
   * Length of the fragment that failed to parse. A size, never the text:
   * this value reaches diagnostics and telemetry, and argument fragments can
   * contain user data.
   */
  fragmentLength?: number
}

/**
 * This call's decode status, or undefined when it decoded cleanly.
 *
 * Reads only the envelope. A `_tau_decode_status` property inside `input` is
 * model-supplied data and is ignored.
 */
export function decodeStatusOf(block: unknown): ToolDecodeStatus | undefined {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return undefined
  }
  const candidate = (block as Record<string, unknown>)[TOOL_DECODE_STATUS_KEY]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined
  }
  const category = (candidate as Record<string, unknown>).category
  if (
    category !== 'missing' &&
    category !== 'truncated' &&
    category !== 'malformed' &&
    category !== 'invalid_root'
  ) {
    return undefined
  }
  const fragmentLength = (candidate as Record<string, unknown>).fragmentLength
  return {
    category,
    ...(typeof fragmentLength === 'number' &&
    Number.isFinite(fragmentLength) && fragmentLength >= 0
      ? { fragmentLength }
      : {}),
  }
}

/** What the model is told when a call's arguments never arrived complete. */
export function describeDecodeFailure(
  toolName: string,
  status: ToolDecodeStatus,
): string {
  const cause =
    status.category === 'missing'
      ? 'no complete argument object was received'
      : status.category === 'truncated'
        ? 'the streamed JSON ended before the arguments were complete'
        : status.category === 'malformed'
          ? 'the streamed JSON could not be parsed'
          : 'the arguments did not arrive as a JSON object'
  return (
    `${toolName} was not run: ${cause}. ` +
    `Nothing was executed, so no partial call took effect. ` +
    `Send the call again with its full arguments.`
  )
}

export type DecodedToolArguments = {
  input: Record<string, unknown>
  status?: ToolDecodeStatus
}

/** Decode object-argument protocols without turning failed JSON into a call. */
export function decodeToolArguments(raw: unknown): DecodedToolArguments {
  const fragmentLength = typeof raw === 'string' ? raw.length : undefined
  const fail = (category: ToolDecodeFailureCategory): DecodedToolArguments => ({
    input: {},
    status: { category, ...(fragmentLength !== undefined && { fragmentLength }) },
  })
  if (raw === undefined || (typeof raw === 'string' && raw.trim().length === 0)) {
    return fail('missing')
  }
  let input = raw
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw)
    } catch {
      return fail('malformed')
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail('invalid_root')
  }
  return { input: input as Record<string, unknown> }
}

/** Internal block metadata, never part of the tool's argument object. */
export function toolDecodeFields(decoded: DecodedToolArguments): {
  _tau_decode_status?: ToolDecodeStatus
} {
  return decoded.status ? { [TOOL_DECODE_STATUS_KEY]: decoded.status } : {}
}
