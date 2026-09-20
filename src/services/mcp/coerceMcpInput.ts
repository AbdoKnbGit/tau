/**
 * Coerce MCP tool arguments toward the server's own JSON Schema.
 *
 * `coerceToolInput` recovers the common model mistakes — a stringified array,
 * a numeric string, a near-miss key spelling — but it reads the expected types
 * off the tool's **Zod** schema. Every MCP tool shares `MCPTool`'s placeholder
 * `z.object({}).passthrough()`, which declares no properties, so that pass
 * returns immediately and does nothing at all for MCP. The real types are in
 * `inputJSONSchema`, which it never looks at.
 *
 * The result was that a model emitting `{"batch": "[{...}]"` — a JSON string
 * where an array belongs — was repaired on the Cline lane, which grew its own
 * copy of this logic, and on no other lane. Everywhere else the string went
 * straight to the server, or (once arguments are validated) was rejected
 * without ever being repaired.
 *
 * This is the same recovery, driven by the JSON Schema, so it applies to any
 * MCP tool on any provider.
 *
 * It is deliberately conservative, because a wrong repair is worse than a
 * rejection the model can see and correct:
 *
 * - it only ever changes a value whose current type the schema does not
 *   accept, and only to a type the schema does accept;
 * - it parses a string into an array or object only when the parse succeeds
 *   and the result fits; a malformed payload is left exactly as it arrived,
 *   so validation reports it rather than a guess built from it;
 * - it never invents a field, fills in a required one, or drops an
 *   unrecognized one.
 */

/** Depth cap: schemas are third-party, and recursion must terminate. */
const MAX_COERCE_DEPTH = 12

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Schema = Record<string, unknown>

/** The JSON Schema types this node accepts, as a set. Empty means unstated. */
function acceptedTypes(schema: Schema): Set<string> {
  const declared = schema.type
  if (typeof declared === 'string') return new Set([declared])
  if (Array.isArray(declared)) {
    return new Set(declared.filter((t): t is string => typeof t === 'string'))
  }
  return new Set()
}

/** The JSON Schema type name for a runtime value. */
function typeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  return typeof value
}

/**
 * Does this schema already accept the value as it stands?
 *
 * A schema that states no type accepts anything, so there is nothing to
 * repair. `integer` is accepted by `number` too.
 */
function alreadyAccepted(schema: Schema, value: unknown): boolean {
  const accepted = acceptedTypes(schema)
  if (accepted.size === 0) return true
  const actual = typeOfValue(value)
  if (accepted.has(actual)) return true
  if (actual === 'integer' && accepted.has('number')) return true
  return false
}

/** The branches of a composition keyword, if this node is one. */
function compositionBranches(schema: Schema): Schema[] {
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[keyword]
    if (Array.isArray(branches)) {
      return branches.filter(isPlainObject)
    }
  }
  return []
}

/**
 * Parse a string that looks like JSON. Returns undefined when it is not
 * JSON-shaped or does not parse — a corrupt payload is left alone.
 */
function parseJsonLike(value: string): unknown | undefined {
  const trimmed = value.trim()
  if (trimmed.length < 2) return undefined
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  const looksJson =
    (first === '[' && last === ']') || (first === '{' && last === '}')
  if (!looksJson) return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** Repair a scalar toward a type this schema accepts, or leave it alone. */
function coerceScalar(value: unknown, schema: Schema): unknown {
  const accepted = acceptedTypes(schema)

  // A number or boolean where only a string is accepted.
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (accepted.has('string') && !accepted.has(typeOfValue(value))) {
      return String(value)
    }
    return value
  }

  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value

  // A JSON string where a structure belongs. This is the case that sent
  // `"[{...}]"` to servers expecting an array.
  if (accepted.has('array') || accepted.has('object')) {
    const parsed = parseJsonLike(trimmed)
    if (parsed !== undefined && accepted.has(typeOfValue(parsed))) {
      return parsed
    }
  }

  if (
    (accepted.has('number') || accepted.has('integer')) &&
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)
  ) {
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      // An integer-only field must not silently accept 1.5.
      if (!accepted.has('number') && !Number.isInteger(numeric)) return value
      return numeric
    }
  }

  if (accepted.has('boolean') && !accepted.has('string')) {
    const lower = trimmed.toLowerCase()
    if (lower === 'true') return true
    if (lower === 'false') return false
  }

  if (accepted.has('null') && !accepted.has('string') && trimmed === 'null') {
    return null
  }

  return value
}

function coerceAgainstSchema(
  value: unknown,
  schema: Schema,
  depth: number,
): unknown {
  if (depth > MAX_COERCE_DEPTH) return value

  // A composition: repair against the branch that can take this value, or
  // that the value can be repaired into. If none fits, leave it for
  // validation to report.
  const branches = compositionBranches(schema)
  if (branches.length > 0) {
    // A branch that already accepts the value wins outright. For a union of
    // string and array, a JSON-looking string is a *valid* string, and the
    // schema says so — parsing it would be overriding the contract with a
    // guess about which branch was meant.
    const direct = branches.find(branch => alreadyAccepted(branch, value))
    if (direct) return coerceAgainstSchema(value, direct, depth + 1)
    for (const branch of branches) {
      const repaired = coerceAgainstSchema(value, branch, depth + 1)
      if (repaired !== value && alreadyAccepted(branch, repaired)) {
        return repaired
      }
    }
    return value
  }

  if (!alreadyAccepted(schema, value)) {
    const repaired = coerceScalar(value, schema)
    if (repaired !== value) {
      // Recurse once into the repaired structure, so a parsed array's items
      // are repaired too.
      return coerceAgainstSchema(repaired, schema, depth + 1)
    }
    return value
  }

  if (Array.isArray(value)) {
    const items = isPlainObject(schema.items) ? (schema.items as Schema) : null
    if (!items) return value
    let changed = false
    const out = value.map(item => {
      const repaired = coerceAgainstSchema(item, items, depth + 1)
      if (repaired !== item) changed = true
      return repaired
    })
    return changed ? out : value
  }

  if (!isPlainObject(value)) return value

  const properties = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {}
  const additional = isPlainObject(schema.additionalProperties)
    ? (schema.additionalProperties as Schema)
    : null

  let changed = false
  const out: Record<string, unknown> = { ...value }
  for (const [key, child] of Object.entries(out)) {
    const declared = properties[key]
    const childSchema = isPlainObject(declared)
      ? (declared as Schema)
      : additional
    // An undeclared property with no additionalProperties schema is left as
    // it is: guessing its type would be inventing a contract.
    if (!childSchema) continue
    const repaired = coerceAgainstSchema(child, childSchema, depth + 1)
    if (repaired !== child) {
      out[key] = repaired
      changed = true
    }
  }
  return changed ? out : value
}

/**
 * Repair an MCP tool's arguments toward its server-declared schema.
 *
 * Returns the input unchanged when there is no schema, nothing needs
 * repairing, or a repair cannot be made safely.
 */
export function coerceMcpInput(
  input: unknown,
  inputJSONSchema: unknown,
): unknown {
  if (!isPlainObject(inputJSONSchema)) return input
  if (!isPlainObject(input)) return input
  return coerceAgainstSchema(input, inputJSONSchema as Schema, 0)
}
