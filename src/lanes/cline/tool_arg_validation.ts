import type {
  AnthropicStreamEvent,
  ProviderTool,
} from '../../services/api/providers/base_provider.js'
import type { OpenAIMessage } from '../../services/api/adapters/anthropic_to_openai.js'
import { buildStrictParamsSummary } from '../shared/mcp_bridge.js'
import { decodeToolArguments, toolDecodeFields } from '../../services/mcp/decodeStatus.js'
import { contractArgumentJudge } from '../../services/mcp/contractValidation.js'
import { dropInvalidPlaceholderArguments } from '../../utils/placeholderArguments.js'

export interface ClineInvalidToolCall {
  toolName: string
  missing: string[]
  received: Record<string, unknown>
  reason: 'missing_required_args' | 'schema_not_sent' | 'invalid_arguments'
  problems?: string[]
}

type JsonSchemaRecord = Record<string, unknown>

interface OpenAIToolCallDeltaLike {
  function?: { arguments?: unknown } | null
}

/**
 * Coerce tool-call `arguments` to the OpenAI-spec JSON string.
 *
 * The OpenAI streaming contract says `tool_calls[].function.arguments` is a
 * string that the client concatenates across deltas. Some upstreams behind the
 * Cline gateway instead emit it as an already-parsed JSON object/array. The
 * Anthropic stream adapter (`openAIStreamToAnthropicEvents`) blindly
 * string-concatenates it, so a non-string degrades to "[object Object]", which
 * fails `JSON.parse` downstream and leaves EVERY tool call decoded as `{}`.
 *
 * Serializing object/array arguments back to a JSON string here makes the
 * adapter see valid JSON. Strings, `null`, and `undefined` pass through
 * untouched, so well-behaved streams are unaffected. Returns the same array
 * reference when nothing changed to keep the hot path allocation-free.
 */
export function coerceClineToolCallArguments<T extends OpenAIToolCallDeltaLike>(
  toolCalls: readonly T[],
): T[] {
  let changed = false
  const out = toolCalls.map((toolCall) => {
    const args = toolCall?.function?.arguments
    if (args === undefined || args === null || typeof args === 'string') {
      return toolCall
    }
    changed = true
    return {
      ...toolCall,
      function: { ...toolCall.function, arguments: JSON.stringify(args) },
    }
  })
  return changed ? out : (toolCalls as T[])
}

export function buildClineRequiredParamMap(
  tools: readonly ProviderTool[],
): Map<string, string[]> {
  const requiredByTool = new Map<string, string[]>()
  for (const tool of tools) {
    const schema = tool.input_schema
    const properties = schema && typeof schema === 'object'
      ? (schema as Record<string, unknown>).properties
      : undefined
    const propertyNames = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? new Set(Object.keys(properties as Record<string, unknown>))
      : null
    const required = Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string =>
        typeof item === 'string' && (!propertyNames || propertyNames.has(item)))
      : []
    requiredByTool.set(tool.name, required)
  }
  return requiredByTool
}

export function normalizeClineToolCallArgumentEvents(
  events: readonly AnthropicStreamEvent[],
  tools: readonly ProviderTool[],
): AnthropicStreamEvent[] {
  const schemaByTool = new Map<string, JsonSchemaRecord>()
  for (const tool of tools) {
    if (isPlainRecord(tool.input_schema)) schemaByTool.set(tool.name, tool.input_schema)
  }

  const states = collectClineToolCallStates(events)
  let next: AnthropicStreamEvent[] | null = null

  for (const state of states.values()) {
    const decoded = decodeToolArguments(
      state.deltaIndexes.length > 0 ? state.partialJson : state.initialInput,
    )
    if (decoded.status) {
      next ??= [...events]
      const start = next[state.startEventIndex]!
      next[state.startEventIndex] = {
        ...start,
        content_block: { ...start.content_block!, ...toolDecodeFields(decoded) },
      }
      continue
    }
    const schema = schemaByTool.get(state.toolName)
    if (!schema) continue

    const received = decoded.input
    const coercedValue = coerceClineToolInputBySchema(received, schema)
    const normalizedValue = stripSchemaOptionalNulls(coercedValue, schema)
    const normalized = isPlainRecord(normalizedValue) ? normalizedValue : received
    if (jsonStringifyStable(normalized) === jsonStringifyStable(received)) continue

    next ??= [...events]
    const normalizedJson = JSON.stringify(normalized)
    if (state.deltaIndexes.length > 0) {
      state.deltaIndexes.forEach((eventIndex, deltaIndex) => {
        next![eventIndex] = replaceClinePartialJsonEvent(
          next![eventIndex]!,
          deltaIndex === 0 ? normalizedJson : '',
        )
      })
    } else {
      next[state.startEventIndex] = replaceClineStartInputEvent(
        next[state.startEventIndex]!,
        normalized,
      )
    }
  }

  return next ?? [...events]
}

export function findClineToolCallsMissingRequiredArgs(
  events: readonly AnthropicStreamEvent[],
  requiredByTool: ReadonlyMap<string, readonly string[]>,
  opts: {
    knownToolNames?: ReadonlySet<string>
    schemaByTool?: ReadonlyMap<string, JsonSchemaRecord>
    advisoryFieldsByTool?: ReadonlyMap<string, readonly string[]>
  } = {},
): ClineInvalidToolCall[] {
  const states = collectClineToolCallStates(events)
  const knownToolNames = opts.knownToolNames
  const schemaByTool = opts.schemaByTool

  const invalid: ClineInvalidToolCall[] = []
  for (const state of states.values()) {
    const isKnownTool = knownToolNames
      ? knownToolNames.has(state.toolName)
      : requiredByTool.has(state.toolName)
    const received = parseClineToolInput(state.partialJson, state.initialInput)

    if (!isKnownTool) {
      invalid.push({
        toolName: state.toolName,
        missing: [],
        received,
        reason: 'schema_not_sent',
      })
      continue
    }

    const required = requiredByTool.get(state.toolName) ?? []
    const missing = required.filter(name => isMissingRequiredToolArg(received[name]))
    if (missing.length > 0) {
      invalid.push({
        toolName: state.toolName,
        missing,
        received,
        reason: 'missing_required_args',
      })
      continue
    }

    const schema = schemaByTool?.get(state.toolName)
    if (!schema) continue

    // Judge the call shared tool execution will run: an optional placeholder
    // the contract rejects reads as omitted there, and a malformed advisory
    // field is dropped (utils/placeholderArguments.ts). Asking the model to
    // resend a call that would run is a wasted round trip.
    const executed = dropInvalidPlaceholderArguments(received, contractArgumentJudge(schema), {
      advisoryFields: opts.advisoryFieldsByTool?.get(state.toolName),
    }).input
    const problems = validateClineToolInputAgainstSchema(executed, schema)
    if (problems.length > 0) {
      invalid.push({
        toolName: state.toolName,
        missing: [],
        received,
        reason: 'invalid_arguments',
        problems,
      })
    }
  }
  return invalid
}

/**
 * Map each tool name to its raw JSON-Schema input, so the repair message can
 * echo the exact expected shape back to the model.
 */
export function buildClineToolSchemaMap(
  tools: readonly ProviderTool[],
): Map<string, JsonSchemaRecord> {
  const byName = new Map<string, JsonSchemaRecord>()
  for (const tool of tools) {
    if (isPlainRecord(tool.input_schema)) byName.set(tool.name, tool.input_schema)
  }
  return byName
}

/** Each tool's advisory fields (ProviderTool.__tau_advisory_fields). */
export function buildClineAdvisoryFieldMap(
  tools: readonly ProviderTool[],
): Map<string, readonly string[]> {
  const byName = new Map<string, readonly string[]>()
  for (const tool of tools) {
    if (tool.__tau_advisory_fields?.length) byName.set(tool.name, tool.__tau_advisory_fields)
  }
  return byName
}

export function buildClineToolArgRepairMessage(
  invalidToolCalls: readonly ClineInvalidToolCall[],
  attempt: number,
  schemaByTool?: ReadonlyMap<string, JsonSchemaRecord>,
): OpenAIMessage {
  // Weak models on the Cline gateway repeatedly emit `{}` / partial args even
  // when the tool schema is fully present in the request. A terse "missing X"
  // nudge is not enough — spell out the exact parameter names + types and a
  // minimal valid call so the model has a concrete shape to copy on retry.
  const details = invalidToolCalls
    .map(call => {
      const schema = schemaByTool?.get(call.toolName)
      if (call.reason === 'schema_not_sent') {
        return [
          `- ${call.toolName}: you called this tool with ${JSON.stringify(call.received)}, but its parameter schema was not declared in the current Cline request.`,
          '    Do not call tools from memory or from deferred-tool name reminders.',
          '    If ToolSearch is available and this is a deferred tool, call ToolSearch with query "select:<ExactToolName>" first; otherwise choose one of the currently declared tools.',
        ].join('\n')
      }

      if (call.reason === 'invalid_arguments') {
        const lines = [
          `- ${call.toolName}: you sent ${JSON.stringify(call.received)}, but the arguments do not match the declared parameter schema.`,
          `    Problems: ${(call.problems ?? ['invalid arguments']).join('; ')}`,
        ]
        if (schema) {
          lines.push(`    Parameters: ${buildStrictParamsSummary(schema)}`)
          lines.push(`    Minimal valid call: ${buildClineMinimalExample(schema, call.missing)}`)
        }
        lines.push('    Send arrays/objects as real JSON values, not quoted JSON strings.')
        return lines.join('\n')
      }

      const missingList = call.missing.map(name => `"${name}"`).join(', ')
      const lines = [
        `- ${call.toolName}: you sent ${JSON.stringify(call.received)} — required ${missingList} ${call.missing.length === 1 ? 'is' : 'are'} missing.`,
      ]
      if (schema) {
        lines.push(`    Parameters: ${buildStrictParamsSummary(schema)}`)
        lines.push(`    Minimal valid call: ${buildClineMinimalExample(schema, call.missing)}`)
      }
      return lines.join('\n')
    })
    .join('\n')

  return {
    role: 'user',
    content: [
      '<tool_call_validation_error>',
      `Attempt ${attempt}: the previous tool call(s) were rejected before Tau executed anything because they were invalid for the current Cline tool schema set.`,
      details,
      'For any call whose schema was not declared, do not retry that tool directly. Load it with ToolSearch first if ToolSearch is available, or use one of the currently declared tools.',
      'Re-issue every call now with all required fields filled, parameter names copied exactly (case-sensitive), and values using the declared types. Do not send empty {}.',
      '</tool_call_validation_error>',
    ].join('\n'),
  }
}

export function buildClineBlockedInvalidToolCallText(
  invalidToolCalls: readonly ClineInvalidToolCall[],
): string {
  const details = invalidToolCalls
    .map(call => {
      if (call.reason === 'schema_not_sent') {
        return `- ${call.toolName}: schema was not declared in the current Cline request; received ${JSON.stringify(call.received)}`
      }
      if (call.reason === 'invalid_arguments') {
        return `- ${call.toolName}: arguments did not match schema (${(call.problems ?? ['invalid arguments']).join('; ')}); received ${JSON.stringify(call.received)}`
      }
      return `- ${call.toolName}: missing ${call.missing.map(name => `"${name}"`).join(', ')}; received ${JSON.stringify(call.received)}`
    })
    .join('\n')

  return [
    'Cline emitted invalid tool calls after internal repair attempts, so Tau blocked them before local execution.',
    details,
    'No local tool was run with empty arguments.',
  ].join('\n')
}

function coerceClineToolInputBySchema(
  value: unknown,
  schema: JsonSchemaRecord,
): unknown {
  const recovered = recoverRawClineToolInput(value)
  const input = recovered ?? value

  const variants = schemaVariants(schema)
  if (variants.length > 0) {
    const matchingVariant =
      variants.find(variant => stringCanCoerceToSchemaType(input, variant))
      ?? variants.find(variant => schemaAcceptsValueBasicType(variant, input))
    if (matchingVariant) {
      return coerceClineToolInputBySchema(input, matchingVariant)
    }
  }

  const coercedScalar = coerceClineScalarBySchema(input, schema)
  if (coercedScalar !== input) {
    return coerceClineToolInputBySchema(coercedScalar, schema)
  }

  if (Array.isArray(input)) {
    const itemSchema = isPlainRecord(schema.items) ? schema.items : undefined
    return itemSchema
      ? input.map(item => coerceClineToolInputBySchema(item, itemSchema))
      : input
  }

  if (!isPlainRecord(input)) return input

  const properties = isPlainRecord(schema.properties) ? schema.properties : {}
  let changed = false
  const out: Record<string, unknown> = { ...input }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue
    if (!isPlainRecord(childSchema)) continue
    const before = out[key]
    const after = coerceClineToolInputBySchema(before, childSchema)
    if (after !== before) {
      out[key] = after
      changed = true
    }
  }
  return changed ? out : input
}

function coerceClineScalarBySchema(value: unknown, schema: JsonSchemaRecord): unknown {
  const acceptedTypes = schemaAcceptedTypes(schema)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return acceptedTypes.has('string') && acceptedTypes.size === 1
      ? String(value)
      : value
  }
  if (typeof value !== 'string') return value

  const trimmed = value.trim()
  if (!trimmed) return value

  const parsedJson = parseJsonLookingString(trimmed)
  if (
    parsedJson !== undefined
    && schemaAcceptsValueBasicType(schema, parsedJson)
  ) {
    return parsedJson
  }

  if (
    (acceptedTypes.has('number') || acceptedTypes.has('integer'))
    && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)
  ) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) return numeric
  }

  if (acceptedTypes.has('boolean')) {
    const lower = trimmed.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }

  return value
}

function validateClineToolInputAgainstSchema(
  value: unknown,
  schema: JsonSchemaRecord,
  path = '',
): string[] {
  if (isRawSentinel(value)) {
    return [`${path || 'arguments'} must be a valid JSON object`]
  }

  const variants = schemaVariants(schema)
  if (variants.length > 0) {
    const variantResults = variants.map(variant =>
      validateClineToolInputAgainstSchema(value, variant, path))
    if (variantResults.some(result => result.length === 0)) return []
    return [
      `${path || 'value'} must match one of the allowed schema variants`,
      ...shortestProblems(variantResults),
    ]
  }

  const expectedTypes = schemaAcceptedTypes(schema)
  const actualType = jsonTypeName(value)
  if (
    expectedTypes.size > 0
    && !expectedTypes.has(actualType)
    && !(actualType === 'integer' && expectedTypes.has('number'))
    && !(actualType === 'number' && expectedTypes.has('integer') && Number.isInteger(value))
  ) {
    return [`${path || 'value'} must be ${[...expectedTypes].join(' or ')}, received ${actualType}`]
  }

  const problems: string[] = []
  const schemaLooksObject = expectedTypes.has('object') || isPlainRecord(schema.properties)
  if (schemaLooksObject && isPlainRecord(value)) {
    const properties = isPlainRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : []
    for (const key of required) {
      if (isMissingRequiredToolArg(value[key])) {
        problems.push(`${joinSchemaPath(path, key)} is required`)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key]
      if (!isPlainRecord(childSchema)) continue
      problems.push(
        ...validateClineToolInputAgainstSchema(child, childSchema, joinSchemaPath(path, key)),
      )
    }
  }

  const schemaLooksArray = expectedTypes.has('array') || isPlainRecord(schema.items)
  if (schemaLooksArray && Array.isArray(value) && isPlainRecord(schema.items)) {
    value.slice(0, 20).forEach((item, index) => {
      problems.push(
        ...validateClineToolInputAgainstSchema(item, schema.items as JsonSchemaRecord, `${path || 'value'}[${index}]`),
      )
    })
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${path || 'value'} must be one of ${schema.enum.map(String).join(', ')}`)
  }

  return problems.slice(0, 12)
}

function schemaVariants(schema: JsonSchemaRecord): JsonSchemaRecord[] {
  const variants: JsonSchemaRecord[] = []
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[key]
    if (Array.isArray(value)) {
      variants.push(...value.filter(isPlainRecord))
    }
  }
  return variants
}

function schemaAcceptedTypes(schema: JsonSchemaRecord): Set<string> {
  const types = new Set<string>()
  const rawType = schema.type
  if (typeof rawType === 'string') types.add(normalizeJsonSchemaType(rawType))
  if (Array.isArray(rawType)) {
    for (const item of rawType) {
      if (typeof item === 'string') types.add(normalizeJsonSchemaType(item))
    }
  }
  if (types.size === 0 && isPlainRecord(schema.properties)) types.add('object')
  if (types.size === 0 && isPlainRecord(schema.items)) types.add('array')
  if (types.size === 0 && Array.isArray(schema.enum)) {
    for (const item of schema.enum) types.add(jsonTypeName(item))
  }
  return types
}

function schemaAcceptsValueBasicType(schema: JsonSchemaRecord, value: unknown): boolean {
  const variants = schemaVariants(schema)
  if (variants.length > 0) {
    return variants.some(variant => schemaAcceptsValueBasicType(variant, value))
  }
  const accepted = schemaAcceptedTypes(schema)
  if (accepted.size === 0) return true
  const actual = jsonTypeName(value)
  return (
    accepted.has(actual)
    || (actual === 'integer' && accepted.has('number'))
    || (actual === 'number' && accepted.has('integer') && Number.isInteger(value))
  )
}

function stringCanCoerceToSchemaType(value: unknown, schema: JsonSchemaRecord): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  const parsed = parseJsonLookingString(trimmed)
  if (parsed !== undefined && schemaAcceptsValueBasicType(schema, parsed)) return true
  const accepted = schemaAcceptedTypes(schema)
  return (
    (accepted.has('number') || accepted.has('integer'))
    && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)
  ) || (
    accepted.has('boolean')
    && /^(?:true|false)$/i.test(trimmed)
  )
}

function parseJsonLookingString(value: string): unknown | undefined {
  const first = value[0]
  const last = value[value.length - 1]
  if (!(
    (first === '{' && last === '}')
    || (first === '[' && last === ']')
    || (first === '"' && last === '"')
  )) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function recoverRawClineToolInput(value: unknown): Record<string, unknown> | null {
  if (!isRawSentinel(value)) return null
  const raw = String((value as Record<string, unknown>)._raw).trim()
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fence?.[1]?.trim() ?? raw
  try {
    let parsed = JSON.parse(candidate) as unknown
    if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown
    if (isPlainRecord(parsed)) return parsed
  } catch {
    // Keep the original sentinel so validation can ask Cline to resend.
  }
  return null
}

function isRawSentinel(value: unknown): boolean {
  return (
    isPlainRecord(value)
    && typeof value._raw === 'string'
    && Object.keys(value).length === 1
  )
}

function normalizeJsonSchemaType(type: string): string {
  return type === 'integer' ? 'integer' : type
}

function jsonTypeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function joinSchemaPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key
}

function shortestProblems(results: string[][]): string[] {
  const sorted = [...results].sort((left, right) => left.length - right.length)
  return sorted[0]?.slice(0, 4) ?? []
}

/**
 * Build a minimal illustrative call containing just the required fields, typed
 * placeholders picked from each field's schema. Illustrative only — it shows
 * the model which keys to fill, not real values.
 */
function buildClineMinimalExample(
  schema: JsonSchemaRecord,
  missing: readonly string[],
): string {
  const properties = isPlainRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  const fields = required.length > 0 ? required : [...missing]
  const example: Record<string, unknown> = {}
  for (const name of fields) {
    example[name] = clinePlaceholderForSchema(properties[name])
  }
  return JSON.stringify(example)
}

function clinePlaceholderForSchema(propSchema: unknown): unknown {
  if (!isPlainRecord(propSchema)) return '…'
  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    return propSchema.enum[0]
  }
  switch (normalizeSchemaTypeName(propSchema.type)) {
    case 'array': return []
    case 'object': return {}
    case 'number':
    case 'integer': return 0
    case 'boolean': return false
    default: return '…'
  }
}

function normalizeSchemaTypeName(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.find(item => typeof item === 'string' && item !== 'null')
    if (typeof nonNull === 'string') return nonNull
  }
  return undefined
}

function collectClineToolCallStates(
  events: readonly AnthropicStreamEvent[],
): Map<number, {
  toolName: string
  initialInput: Record<string, unknown>
  partialJson: string
  startEventIndex: number
  deltaIndexes: number[]
}> {
  const states = new Map<number, {
    toolName: string
    initialInput: Record<string, unknown>
    partialJson: string
    startEventIndex: number
    deltaIndexes: number[]
  }>()

  events.forEach((event, eventIndex) => {
    const index = typeof (event as { index?: unknown }).index === 'number'
      ? (event as { index: number }).index
      : 0

    if (event.type === 'content_block_start') {
      const block = (event as { content_block?: unknown }).content_block as {
        type?: string
        name?: string
        input?: unknown
      } | undefined
      if (block?.type !== 'tool_use' || !block.name) return
      states.set(index, {
        toolName: block.name,
        initialInput: isPlainRecord(block.input) ? block.input : {},
        partialJson: '',
        startEventIndex: eventIndex,
        deltaIndexes: [],
      })
      return
    }

    if (event.type === 'content_block_delta') {
      const state = states.get(index)
      const delta = (event as { delta?: unknown }).delta as {
        type?: string
        partial_json?: string
      } | undefined
      if (state && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        state.partialJson += delta.partial_json
        state.deltaIndexes.push(eventIndex)
      }
    }
  })

  return states
}

function stripSchemaOptionalNulls(
  value: unknown,
  schema: JsonSchemaRecord,
): unknown {
  if (Array.isArray(value)) {
    const itemSchema = isPlainRecord(schema.items) ? schema.items : undefined
    return itemSchema
      ? value.map(item => stripSchemaOptionalNulls(item, itemSchema))
      : value
  }
  if (!isPlainRecord(value)) return value

  const properties = isPlainRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  )
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const hasExplicitChildSchema = Object.prototype.hasOwnProperty.call(properties, key)
    const childSchema = properties[key]
    if (child === null && hasExplicitChildSchema && !required.has(key)) continue
    out[key] = hasExplicitChildSchema && isPlainRecord(childSchema)
      ? stripSchemaOptionalNulls(child, childSchema)
      : child
  }
  return out
}

function replaceClinePartialJsonEvent(
  event: AnthropicStreamEvent,
  partialJson: string,
): AnthropicStreamEvent {
  if (event.type !== 'content_block_delta') return event
  return {
    ...event,
    delta: {
      ...event.delta,
      partial_json: partialJson,
    },
  } as AnthropicStreamEvent
}

function replaceClineStartInputEvent(
  event: AnthropicStreamEvent,
  input: Record<string, unknown>,
): AnthropicStreamEvent {
  if (event.type !== 'content_block_start') return event
  const block = event.content_block
  if (!block || block.type !== 'tool_use') return event
  return {
    ...event,
    content_block: {
      ...block,
      input,
    },
  } as AnthropicStreamEvent
}

function parseClineToolInput(
  partialJson: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const raw = partialJson.trim()
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as unknown
    return isPlainRecord(parsed) ? parsed : { _raw: raw }
  } catch {
    return { _raw: raw }
  }
}

function isMissingRequiredToolArg(value: unknown): boolean {
  return (
    value === undefined
    || value === null
    || (typeof value === 'string' && value.trim().length === 0)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonStringifyStable(value: unknown): string {
  return JSON.stringify(value)
}
