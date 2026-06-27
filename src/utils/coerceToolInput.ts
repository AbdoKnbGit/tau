/**
 * Coerce model-provided tool inputs to match the expected Zod schema types.
 *
 * Non-frontier models (especially free-tier OpenRouter models like Nemotron,
 * Llama, etc.) frequently emit JSON strings for typed parameters — e.g.
 * `"allowedPrompts": "[{...}]"` instead of `"allowedPrompts": [{...}]`.
 *
 * This utility performs a shallow, conservative coercion pass BEFORE Zod
 * validation. If coercion produces invalid data, the downstream Zod
 * `safeParse()` still rejects it — this is a best-effort recovery layer,
 * not a replacement for validation.
 *
 * Coercions performed:
 *   - string → array:   JSON.parse if the string looks like "[...]"
 *   - string → object:  JSON.parse if the string looks like "{...}"
 *   - string → number:  parseFloat if the string is numeric
 *   - string → boolean: "true"/"false" → true/false
 *   - number/boolean → string: String(value) for string-typed params
 *
 * It also performs key recovery: an input key that isn't a schema property but
 * normalizes (casing, `_`/`-`) to one that is — e.g. `filePath` → `file_path`,
 * `oldString` → `old_string` — is renamed when the canonical key is absent.
 */

import type { ZodTypeAny } from 'zod/v4'

/**
 * Extract the expected Zod type string for a schema node.
 * Returns the `_zod.def.type` discriminator (e.g. "array", "object",
 * "number", "boolean", "string") or null if unreadable.
 */
function getZodType(schema: ZodTypeAny): string | null {
  try {
    // Zod v4 exposes `_zod.def.type` as the discriminator
    const def = (schema as any)?._zod?.def ?? (schema as any)?._def
    if (def?.type) return def.type as string
    // Fallback: some Zod wrappers (optional, default, nullable) wrap an inner type
    if (def?.innerType) return getZodType(def.innerType)
    if (def?.schema) return getZodType(def.schema)
    return null
  } catch {
    return null
  }
}

/**
 * Extract property schemas from a Zod object schema.
 * Returns a Map of property name → ZodTypeAny, or null if not an object schema.
 */
function getObjectProperties(schema: ZodTypeAny): Map<string, ZodTypeAny> | null {
  try {
    const def = (schema as any)?._zod?.def ?? (schema as any)?._def
    const shape = def?.shape
    if (shape && typeof shape === 'object') {
      return new Map(Object.entries(shape) as Array<[string, ZodTypeAny]>)
    }
    return null
  } catch {
    return null
  }
}

/**
 * Unwrap optional/nullable/default wrappers to get the inner schema.
 */
function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  try {
    const def = (schema as any)?._zod?.def ?? (schema as any)?._def
    const type = def?.type
    if (type === 'optional' || type === 'nullable' || type === 'default') {
      const inner = def?.innerType ?? def?.schema
      if (inner) return unwrapSchema(inner)
    }
    return schema
  } catch {
    return schema
  }
}

function isOptionalLikeSchema(schema: ZodTypeAny): boolean {
  try {
    const def = (schema as any)?._zod?.def ?? (schema as any)?._def
    const type = def?.type
    return type === 'optional' || type === 'default'
  } catch {
    return false
  }
}

/**
 * Normalize a key for fuzzy matching: lowercase and strip `_`/`-` separators,
 * so `filePath` / `file-path` both match the schema's `file_path`.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/**
 * Try to coerce a single value from string to the expected type.
 * Returns the coerced value, or the original if coercion isn't applicable.
 */
function coerceValue(value: unknown, expectedType: string): unknown {
  // number/boolean → string: models sometimes emit a bare numeric or boolean
  // literal for a string-typed param (e.g. taskId: 3 instead of "3").
  if (expectedType === 'string') {
    return typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : value
  }

  if (typeof value !== 'string') return value

  switch (expectedType) {
    case 'array': {
      const trimmed = value.trim()
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try { return JSON.parse(trimmed) } catch { /* fall through */ }
      }
      return value
    }
    case 'object': {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { return JSON.parse(trimmed) } catch { /* fall through */ }
      }
      return value
    }
    case 'number':
    case 'float':
    case 'int':
    case 'integer': {
      const num = Number(value)
      if (!isNaN(num) && value.trim() !== '') return num
      return value
    }
    case 'boolean': {
      const lower = value.trim().toLowerCase()
      if (lower === 'true') return true
      if (lower === 'false') return false
      return value
    }
    default:
      return value
  }
}

/**
 * Escape literal control characters (newline, carriage-return, tab) that appear
 * *inside* JSON string literals. Models occasionally emit a raw newline inside a
 * large `content`/`new_string` value instead of `\n`, which breaks JSON.parse.
 * This is lossless: valid JSON has no unescaped control chars inside strings, so
 * the transform is a no-op on already-valid input.
 */
function escapeControlCharsInStrings(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (esc) {
      out += ch
      esc = false
    } else if (ch === '\\') {
      out += ch
      esc = true
    } else if (ch === '"') {
      inStr = !inStr
      out += ch
    } else if (inStr && ch === '\n') {
      out += '\\n'
    } else if (inStr && ch === '\r') {
      out += '\\r'
    } else if (inStr && ch === '\t') {
      out += '\\t'
    } else {
      out += ch
    }
  }
  return out
}

/**
 * Lanes set `{ _raw: <string> }` as a sentinel when tool-call arguments fail to
 * JSON.parse. Try to recover the intended object with LOSSLESS repairs only:
 * strip a markdown code fence, escape stray in-string control chars, and undo
 * double-encoding. Returns null if none yield a plain object — notably it never
 * force-closes truncated JSON, so a genuinely cut-off call still fails and the
 * model resends rather than writing a partial file.
 */
function recoverRawToolArgs(raw: string): Record<string, unknown> | null {
  let base = raw.trim()
  const fence = base.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1] !== undefined) base = fence[1].trim()

  for (const candidate of [base, escapeControlCharsInStrings(base)]) {
    try {
      let parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'string') parsed = JSON.parse(parsed) // double-encoded
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Coerce tool input values to match the expected schema types.
 *
 * This is a shallow pass — it coerces top-level properties of the input
 * object based on the schema's expected types. It does NOT deeply recurse
 * into nested objects (Zod validation handles deeper structure).
 *
 * @param input  Raw model-provided input object
 * @param schema The tool's Zod input schema
 * @returns A new object with coerced values (or the original if no schema)
 */
export function coerceToolInput(
  input: Record<string, unknown>,
  schema: ZodTypeAny,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input

  // Recover from the `_raw` sentinel a lane sets when tool-call args failed to
  // JSON.parse — otherwise every required field reads as "missing". Lossless
  // repairs only (see recoverRawToolArgs); on failure we leave `_raw` so
  // validation still rejects and the model resends.
  if (typeof input._raw === 'string' && Object.keys(input).length === 1) {
    const recovered = recoverRawToolArgs(input._raw)
    if (recovered) input = recovered
  }

  const unwrapped = unwrapSchema(schema)
  const properties = getObjectProperties(unwrapped)
  if (!properties || properties.size === 0) return input

  let mutated = false
  const result: Record<string, unknown> = { ...input }

  // Key recovery: a model may emit a property under a near-miss spelling
  // (camelCase vs snake_case / casing) — e.g. `filePath` for `file_path`. When
  // an input key isn't a schema property but normalizes to one that is (and the
  // canonical key is absent), rename it. Pure omissions still fail validation.
  const canonicalByNorm = new Map<string, string>()
  for (const key of properties.keys()) {
    canonicalByNorm.set(normalizeKey(key), key)
  }
  for (const key of Object.keys(result)) {
    if (properties.has(key)) continue
    const canonical = canonicalByNorm.get(normalizeKey(key))
    if (canonical && !(canonical in result)) {
      result[canonical] = result[key]
      delete result[key]
      mutated = true
    }
  }

  for (const [key, propSchema] of properties) {
    if (!(key in result)) continue

    if (result[key] === null && isOptionalLikeSchema(propSchema)) {
      delete result[key]
      mutated = true
      continue
    }

    const innerSchema = unwrapSchema(propSchema)
    const expectedType = getZodType(innerSchema)
    if (!expectedType) continue

    const original = result[key]
    const coerced = coerceValue(original, expectedType)
    if (coerced !== original) {
      result[key] = coerced
      mutated = true
    }
  }

  return mutated ? result : input
}
