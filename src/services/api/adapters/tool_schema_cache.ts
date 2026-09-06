/**
 * Records the parameter schema of every tool that goes out to a non-Anthropic
 * provider so that, on the way back, we can repair model output that arrived
 * shaped wrong (e.g. a JSON-encoded string for a parameter the schema declares
 * as `array` or `object`).
 *
 * Inspired by the antigravity / CLIProxyAPI approach: the model sometimes
 * stringifies structured args. Without the original schema, the inbound
 * adapter has no way to know whether to JSON.parse a string. The cache is
 * populated at outbound time (in each anthropic_to_<provider> adapter) and
 * consulted at inbound time (in each <provider>_to_anthropic adapter).
 *
 * Last-write-wins: the same tool name within the same session/process
 * overwrites prior entries so updated schemas take precedence.
 *
 * Conflict safety: the cache is keyed by tool NAME, but the inbound side only
 * ever knows the name the provider echoed back — it cannot know which schema
 * produced the call. So when two different schemas are registered under one
 * name (concurrent subagents carrying their own StructuredOutput contract, two
 * MCP servers exposing a same-named tool), a parameter whose declared type
 * disagrees between them is marked ambiguous and never coerced. Skipping the
 * repair leaves the raw provider value untouched — the pre-repair behavior,
 * and a visible validation failure downstream — whereas coercing against the
 * wrong schema silently rewrites the payload. The Anthropic-facing render
 * cache hit this same collision and fixed it by keying on the schema
 * (utils/api.ts); that fix is unavailable here, so we fail safe instead.
 */

export interface SchemaInfo {
  type: string
  items?: SchemaInfo
  properties?: Record<string, SchemaInfo>
}

interface ToolSchemaEntry {
  /** Params from the most recent write — last-write-wins, as before. */
  params: Map<string, SchemaInfo>
  /** Top-level `name:type` digest of the most recent write, for a no-op fast path. */
  shape: string
  /** Params whose top-level type disagreed across writes. Never coerced. */
  ambiguous: Set<string>
}

const cache = new Map<string, ToolSchemaEntry>()

/**
 * Deterministic digest of the top-level parameter types — the only thing
 * coercion consults. Nested `items`/`properties` are ignored on purpose: two
 * schemas that agree on every top-level type coerce identically, so treating
 * them as a conflict would disable repair for no benefit.
 */
function shapeOf(params: Map<string, SchemaInfo>): string {
  return [...params]
    .map(([name, info]) => `${name}:${info.type}`)
    .sort()
    .join(',')
}

function normalizeType(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter(t => t !== 'null')
    const first = nonNull[0] ?? value[0]
    if (typeof first === 'string') return first
  }
  return 'unknown'
}

function extract(schema: unknown): SchemaInfo {
  if (!schema || typeof schema !== 'object') return { type: 'unknown' }
  const record = schema as Record<string, unknown>
  const type = normalizeType(record.type)
  const info: SchemaInfo = { type }

  if (type === 'array' && record.items) {
    info.items = extract(record.items)
  } else if (type === 'object' && record.properties && typeof record.properties === 'object') {
    info.properties = {}
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      info.properties[key] = extract(value)
    }
  }

  return info
}

/**
 * Records the parameter shape for a tool, keyed by name. Pass the JSON Schema
 * object that has `properties`. Stores nothing for tools without properties
 * but still records the name so repeated calls don't surprise the caller.
 */
export function recordToolSchema(toolName: string, schema: unknown): void {
  if (!toolName) return
  const properties =
    schema && typeof schema === 'object'
      ? (schema as Record<string, unknown>).properties
      : undefined

  const params = new Map<string, SchemaInfo>()
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, paramSchema] of Object.entries(properties as Record<string, unknown>)) {
      params.set(name, extract(paramSchema))
    }
  }

  const shape = shapeOf(params)
  const previous = cache.get(toolName)

  // Identical re-registration (the common case: one schema re-sent every turn,
  // or a workflow reusing the same schema object across dozens of calls).
  if (previous && previous.shape === shape) return

  const ambiguous = new Set(previous?.ambiguous)
  if (previous) {
    // A different shape under the same name means two schemas are live at
    // once. Any parameter the two disagree about — including one that exists
    // in only one of them — can no longer be repaired safely.
    for (const name of new Set([...previous.params.keys(), ...params.keys()])) {
      if (previous.params.get(name)?.type !== params.get(name)?.type) {
        ambiguous.add(name)
      }
    }
  }

  cache.set(toolName, { params, shape, ambiguous })
}

/**
 * Returns the recorded type for a single parameter (e.g. "array", "object"),
 * or undefined when the parameter is ambiguous across colliding schemas.
 */
export function getParamType(toolName: string, paramName: string): string | undefined {
  const entry = cache.get(toolName)
  if (!entry || entry.ambiguous.has(paramName)) return undefined
  return entry.params.get(paramName)?.type
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '{' && last === '}') || (first === '[' && last === ']')
}

/**
 * Walks a tool-call args object and JSON-parses string values whose schema
 * declares them as `array` or `object`. Leaves everything else untouched.
 * Returns the original reference when no coercion was needed.
 */
export function coerceToolCallArgs(toolName: string, args: unknown): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const entry = cache.get(toolName)
  if (!entry || entry.params.size === 0) return args

  const record = args as Record<string, unknown>
  let mutated = false
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    // Ambiguous params keep the provider's raw value: we cannot tell which of
    // the colliding schemas produced this call, and a wrong parse corrupts.
    const expected = entry.ambiguous.has(key)
      ? undefined
      : entry.params.get(key)?.type
    if (
      typeof value === 'string' &&
      (expected === 'array' || expected === 'object') &&
      looksLikeJson(value)
    ) {
      try {
        next[key] = JSON.parse(value)
        mutated = true
        continue
      } catch {
        // fall through and keep the original string
      }
    }
    next[key] = value
  }

  return mutated ? next : args
}

/** Test-only / shutdown helper. */
export function clearToolSchemaCache(): void {
  cache.clear()
}
