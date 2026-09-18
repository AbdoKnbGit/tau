/**
 * Gemini / Antigravity tool-schema converter.
 *
 * Turns any JSON Schema a tool can carry (MCP `inputSchema`, claude.ai
 * connectors, plugins, SDK tools) into a `parameters` schema that Google's
 * function-calling endpoints accept. It is built as an allowlist: the output
 * can only contain fields and shapes the backend was observed to accept, so a
 * new or unusual MCP server cannot 400 the whole request.
 *
 * Every rule below was measured against the live Antigravity backend (proto
 * `google.cloud.aiplatform.master.Schema`) on 2026-09-18, for Gemini models
 * and for Claude resold through Antigravity:
 *
 *   Parse level (the whole request fails, nothing else is checked):
 *     - unknown fields: const, examples, $ref, $defs, definitions,
 *       exclusiveMinimum, multipleOf, uniqueItems, readOnly, deprecated,
 *       contentEncoding, $schema, $id, $comment, patternProperties,
 *       if/then/else, dependentRequired (and other JSON Schema keywords)
 *     - `type` must be ONE known name (no arrays, no "text")
 *     - `enum` entries must be strings; `description` and `format` strings
 *     - int64 fields (minItems, maxLength, ...) must be whole numbers
 *     - `items` must be one schema object (not `true`, not a tuple list)
 *     - message nesting deeper than 64 levels ("recursion depth")
 *   Gemini semantic checks:
 *     - every array needs `items` ("items: missing field"), recursively
 *     - `items` only on arrays; `properties` / `required` only on objects,
 *       including nodes that leave `type` implicit
 *     - every `required` entry must exist in `properties`
 *     - property names cannot be empty
 *   Claude via Antigravity (Anthropic JSON Schema 2020-12 validation):
 *     - the root must be `type: "object"`
 *     - `required` entries must be unique; counts must be >= 0
 *
 * Measured to be accepted (so relied on here): untyped nodes (`{}` means
 * "any value", and VALIDATED mode still lets the model pass objects, strings
 * and numbers through it), `items: {}`, objects without `properties`
 * (the model can still send arbitrary keys), any `format` string.
 *
 * Determinism is a hard requirement: the Antigravity implicit cache is an
 * exact-prefix match on the tool block, so the same input must always give
 * byte-identical output. The converter is a pure function of its input,
 * never mutates it, keeps the input's key order and appends synthesized keys
 * after it, and is idempotent (converting its own output changes nothing).
 */

import { createHash } from 'crypto'

type SchemaObject = Record<string, unknown>

/**
 * Deepest nesting (properties/items steps below the root) kept in full.
 * Measured limit: 30 levels of object nesting, 39 of arrays; the margin
 * covers envelope differences between the Antigravity, Code Assist and API
 * key paths. Deeper subtrees are kept as shallow typed nodes.
 */
export const GEMINI_SCHEMA_MAX_DEPTH = 20

/**
 * Upper bound on schema nodes emitted per tool, so a `$ref` graph that fans
 * out exponentially cannot produce an enormous request. Real MCP tools use a
 * few dozen to a few hundred nodes.
 */
export const GEMINI_SCHEMA_MAX_NODES = 1500

const SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

const STRING_FORMATS = new Set([
  'date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname',
  'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference',
  'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex',
  'byte', 'binary', 'password', 'enum',
])
const INTEGER_FORMATS = new Set(['int32', 'int64', 'uint32', 'uint64'])
const NUMBER_FORMATS = new Set(['float', 'double'])

/** Keys the converter can emit. Everything else is dropped. */
const OUTPUT_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum',
])

interface Ctx {
  root: unknown
  /** `$ref`s being expanded on the current path, for cycle detection. */
  refStack: string[]
  /** Remaining node allowance for this tool. */
  budget: number
}

interface Normalized {
  node: SchemaObject
  /** Refs followed while normalizing this node (pushed while emitting children). */
  followed: string[]
  /** A `$ref` pointed back into the current path. */
  cyclic: boolean
}

function isRecord(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/** Assign as an own property even for keys like "__proto__". */
function setOwn(obj: SchemaObject, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// ─── $ref resolution ─────────────────────────────────────────────

/** Resolve a local JSON pointer (`#`, `#/$defs/X`, `#/definitions/X`, ...). */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let cur: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    let token = raw
    try {
      token = decodeURIComponent(raw)
    } catch {
      // Keep the raw token; a malformed escape just fails to resolve below.
    }
    token = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= cur.length) return undefined
      cur = cur[index]
    } else if (isRecord(cur) && hasOwn(cur, token)) {
      cur = cur[token]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * Follow a node's own `$ref` chain. Siblings of `$ref` apply on top of the
 * target (JSON Schema 2020-12), so the node's description wins over the
 * referenced definition's. Unresolvable refs (external URLs, anchors) are
 * dropped and the siblings kept.
 */
function deref(input: SchemaObject, ctx: Ctx, followed: string[]): { node: SchemaObject; cyclic: boolean } {
  let node = input
  for (let hop = 0; hop < 32 && typeof node.$ref === 'string'; hop++) {
    const ref = node.$ref
    const { $ref: _ref, ...siblings } = node
    const target = resolvePointer(ctx.root, ref)
    if (ctx.refStack.includes(ref) || followed.includes(ref)) {
      // Recursive definition: keep the target's own type and description
      // (emitted shallow by the caller) instead of expanding it again.
      if (!isRecord(target)) return { node: siblings, cyclic: true }
      const { $ref: _inner, ...targetRest } = target
      return { node: { ...targetRest, ...siblings }, cyclic: true }
    }
    followed.push(ref)
    node = isRecord(target) ? { ...target, ...siblings } : siblings
  }
  if ('$ref' in node) {
    const { $ref: _ref, ...rest } = node
    node = rest
  }
  return { node, cyclic: false }
}

// ─── Composition flattening ──────────────────────────────────────

function isNullSchema(schema: SchemaObject): boolean {
  if (schema.type === 'null') return true
  if (Array.isArray(schema.type) && schema.type.length > 0 && schema.type.every(t => t === 'null')) return true
  if (hasOwn(schema, 'const') && schema.const === null) return true
  return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(v => v === null)
}

function isLiteralSchema(schema: SchemaObject): boolean {
  if (isRecord(schema.properties) || schema.items !== undefined) return false
  if (hasOwn(schema, 'const') && isPrimitive(schema.const)) return true
  return Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(isPrimitive)
}

function isObjectSchema(schema: SchemaObject): boolean {
  if (schema.type === 'object') return true
  if (Array.isArray(schema.type)) return schema.type.includes('object')
  return schema.type === undefined && isRecord(schema.properties)
}

/** Copy keys from `source` that `target` does not define (target wins). */
function mergeMissing(target: SchemaObject, source: SchemaObject): SchemaObject {
  const out = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !hasOwn(out, key)) setOwn(out, key, value)
  }
  return out
}

function literalValues(schema: SchemaObject): unknown[] {
  if (hasOwn(schema, 'const')) return [schema.const]
  return Array.isArray(schema.enum) ? schema.enum : []
}

function dedupeValues(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const value of values) {
    const key = JSON.stringify(value)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Object-valued union (e.g. a discriminated union of operations): keep every
 * property any branch declares, turning properties that several branches
 * declare into their own union (so `op: "replace" | "insert"` becomes one
 * enum), and require only what every branch requires.
 */
function mergeObjectBranches(branches: SchemaObject[]): SchemaObject {
  const byKey = new Map<string, unknown[]>()
  for (const branch of branches) {
    if (!isRecord(branch.properties)) continue
    for (const [key, schema] of Object.entries(branch.properties)) {
      const list = byKey.get(key)
      if (list) list.push(schema)
      else byKey.set(key, [schema])
    }
  }
  const properties: SchemaObject = {}
  for (const [key, schemas] of byKey) {
    const unique = dedupeValues(schemas)
    setOwn(properties, key, unique.length === 1 ? unique[0] : { anyOf: unique })
  }
  const requiredSets = branches.map(branch => new Set(
    Array.isArray(branch.required) ? branch.required.filter((r): r is string => typeof r === 'string') : [],
  ))
  const required = [...(requiredSets[0] ?? [])].filter(name => requiredSets.every(set => set.has(name)))
  return {
    type: 'object',
    properties,
    ...(required.length > 0 && { required }),
  }
}

function flattenUnion(node: SchemaObject, keyword: 'anyOf' | 'oneOf', ctx: Ctx, followed: string[]): SchemaObject {
  const { [keyword]: rawBranches, ...base } = node
  let result: SchemaObject = base
  const branches: SchemaObject[] = []
  let allowsAnything = false
  for (const raw of Array.isArray(rawBranches) ? rawBranches : []) {
    if (raw === true || (isRecord(raw) && Object.keys(raw).length === 0)) {
      allowsAnything = true
      continue
    }
    if (isRecord(raw)) branches.push(deref(raw, ctx, followed).node)
  }
  const nonNull = branches.filter(branch => !isNullSchema(branch))
  if (nonNull.length < branches.length) result = { ...result, nullable: true }
  // A branch that accepts anything makes the whole union "any".
  if (allowsAnything || nonNull.length === 0) return result
  if (nonNull.every(isLiteralSchema)) {
    const values = dedupeValues(nonNull.flatMap(literalValues))
    if (values.includes(null)) result = { ...result, nullable: true }
    const types = new Set(nonNull.map(branch => branch.type).filter(t => typeof t === 'string'))
    return mergeMissing(result, {
      ...(types.size === 1 && { type: [...types][0] }),
      enum: values.filter(value => value !== null),
    })
  }
  if (nonNull.length === 1) return mergeMissing(result, nonNull[0]!)
  if (nonNull.every(isObjectSchema)) return mergeMissing(result, mergeObjectBranches(nonNull))
  // Mixed types: keep the first branch. Its values are always valid for the
  // tool, which a looser "any" would not guarantee.
  return mergeMissing(result, nonNull[0]!)
}

function mergeAllOf(node: SchemaObject, ctx: Ctx, followed: string[]): SchemaObject {
  const { allOf, ...base } = node
  const result: SchemaObject = { ...base }
  for (const raw of Array.isArray(allOf) ? allOf : []) {
    if (!isRecord(raw)) continue
    const branch = deref(raw, ctx, followed).node
    for (const [key, value] of Object.entries(branch)) {
      if (value === undefined) continue
      if (key === 'properties' && isRecord(result.properties) && isRecord(value)) {
        result.properties = { ...result.properties, ...value }
      } else if (key === 'required' && Array.isArray(result.required) && Array.isArray(value)) {
        result.required = [...new Set([...result.required, ...value])]
      } else if (!hasOwn(result, key)) {
        setOwn(result, key, value)
      }
    }
  }
  return result
}

/** Resolve refs and flatten composition until the node is plain. */
function normalize(input: SchemaObject, ctx: Ctx): Normalized {
  const followed: string[] = []
  const first = deref(input, ctx, followed)
  let node = first.node
  let cyclic = first.cyclic
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    if (Array.isArray(node.allOf)) {
      node = mergeAllOf(node, ctx, followed)
      changed = true
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(node[keyword])) {
        node = flattenUnion(node, keyword, ctx, followed)
        changed = true
      }
    }
    if (typeof node.$ref === 'string') {
      const next = deref(node, ctx, followed)
      node = next.node
      cyclic ||= next.cyclic
      changed = true
    }
    if (!changed) break
  }
  if (hasOwn(node, 'const') && !Array.isArray(node.enum)) {
    const { const: value, ...rest } = node
    node = value === null ? { ...rest, nullable: true } : isPrimitive(value) ? { ...rest, enum: [value] } : rest
  }
  return { node, followed, cyclic }
}

// ─── Type resolution ─────────────────────────────────────────────

function inferType(node: SchemaObject, enumValues: unknown[]): string | undefined {
  if (
    isRecord(node.properties) || Array.isArray(node.required) || hasOwn(node, 'additionalProperties')
    || isRecord(node.patternProperties) || hasOwn(node, 'minProperties') || hasOwn(node, 'maxProperties')
    || hasOwn(node, 'propertyNames')
  ) return 'object'
  if (
    hasOwn(node, 'items') || Array.isArray(node.prefixItems) || hasOwn(node, 'minItems')
    || hasOwn(node, 'maxItems') || hasOwn(node, 'uniqueItems') || hasOwn(node, 'contains')
  ) return 'array'
  if (enumValues.length > 0) {
    if (enumValues.every(v => typeof v === 'string')) return 'string'
    if (enumValues.every(v => typeof v === 'boolean')) return 'boolean'
    if (enumValues.every(v => typeof v === 'number' && Number.isInteger(v))) return 'integer'
    if (enumValues.every(v => typeof v === 'number')) return 'number'
    return undefined
  }
  if (hasOwn(node, 'minLength') || hasOwn(node, 'maxLength') || typeof node.pattern === 'string') return 'string'
  if (typeof node.format === 'string') {
    if (STRING_FORMATS.has(node.format)) return 'string'
    if (INTEGER_FORMATS.has(node.format)) return 'integer'
    if (NUMBER_FORMATS.has(node.format)) return 'number'
  }
  if (
    hasOwn(node, 'minimum') || hasOwn(node, 'maximum') || hasOwn(node, 'exclusiveMinimum')
    || hasOwn(node, 'exclusiveMaximum') || hasOwn(node, 'multipleOf')
  ) return 'number'
  return undefined
}

function resolveType(node: SchemaObject, enumValues: unknown[]): { type: string | undefined; nullable: boolean } {
  const declared = typeof node.type === 'string'
    ? [node.type]
    : Array.isArray(node.type) ? node.type.filter((t): t is string => typeof t === 'string') : []
  const lowered = declared.map(t => t.toLowerCase())
  const nullable = lowered.includes('null')
  const known = lowered.find(t => SCHEMA_TYPES.has(t))
  return { type: known ?? inferType(node, enumValues), nullable }
}

// ─── Emission ────────────────────────────────────────────────────

function pickItems(node: SchemaObject): unknown {
  if (isRecord(node.items) || node.items === true) return node.items
  // Draft-04 tuple form and 2020-12 prefixItems: the first position is the
  // best single-schema approximation Gemini can express.
  if (Array.isArray(node.items) && node.items.length > 0) return node.items[0]
  if (Array.isArray(node.prefixItems) && node.prefixItems.length > 0) return node.prefixItems[0]
  return undefined
}

function describeAllowedValues(values: unknown[]): string {
  const shown = values.slice(0, 50).map(value => JSON.stringify(value)).join(', ')
  return `Allowed values: ${shown}${values.length > 50 ? ', ...' : ''}`
}

function convert(input: unknown, ctx: Ctx, depth: number): SchemaObject {
  ctx.budget--
  // `true`, missing and non-object schemas all mean "any value".
  if (!isRecord(input)) return {}
  const { node, followed, cyclic } = normalize(input, ctx)
  const shallow = cyclic || depth >= GEMINI_SCHEMA_MAX_DEPTH || ctx.budget <= 0
  ctx.refStack.push(...followed)
  try {
    return emit(node, ctx, depth, shallow)
  } finally {
    ctx.refStack.length -= followed.length
  }
}

function emit(node: SchemaObject, ctx: Ctx, depth: number, shallow: boolean): SchemaObject {
  const rawEnum = Array.isArray(node.enum) ? node.enum.filter(isPrimitive) : []
  const enumValues = dedupeValues(rawEnum.filter(value => value !== null))
  const { type, nullable: typeNullable } = resolveType(node, enumValues)
  const nullable = node.nullable === true || typeNullable || rawEnum.includes(null)

  // Gemini only enforces enums on strings, and a string enum on a numeric
  // type is unsatisfiable JSON Schema for Claude, so other types keep their
  // allowed values as description text instead.
  let enumOut: string[] | undefined
  let description = typeof node.description === 'string' ? node.description : undefined
  if (enumValues.length > 0) {
    if (type === 'string') {
      enumOut = dedupeValues(enumValues.map(value => (typeof value === 'string' ? value : String(value)))) as string[]
    } else {
      const hint = describeAllowedValues(enumValues)
      description = description ? `${description}\n${hint}` : hint
    }
  }

  let properties: SchemaObject | undefined
  let required: string[] | undefined
  if (type === 'object' && !shallow && isRecord(node.properties)) {
    properties = {}
    for (const [key, value] of Object.entries(node.properties)) {
      // Empty names are rejected; `false` properties can never be supplied.
      if (key === '' || value === false) continue
      setOwn(properties, key, convert(value, ctx, depth + 1))
    }
    if (Array.isArray(node.required)) {
      const seen = new Set<string>()
      required = node.required.filter((name): name is string => {
        if (typeof name !== 'string' || seen.has(name) || !hasOwn(properties!, name)) return false
        seen.add(name)
        return true
      })
      if (required.length === 0) required = undefined
    }
  }

  let items: SchemaObject | undefined
  if (type === 'array') {
    const source = pickItems(node)
    items = shallow || source === undefined ? {} : convert(source, ctx, depth + 1)
  }

  const numeric = type === 'number' || type === 'integer'
  const keepFormat = typeof node.format === 'string' && (type === 'string' || numeric)

  // Emit in the input's key order, then append anything synthesized, so a
  // schema that was already valid comes out byte-identical.
  const out: SchemaObject = {}
  for (const key of Object.keys(node)) {
    if (!OUTPUT_KEYS.has(key) && key !== 'prefixItems') continue
    switch (key) {
      case 'type':
        if (type) out.type = type
        break
      case 'format':
        if (keepFormat) out.format = node.format
        break
      case 'description':
        if (description !== undefined) out.description = description
        break
      case 'nullable':
        if (nullable) out.nullable = true
        break
      case 'enum':
        if (enumOut && enumOut.length > 0) out.enum = enumOut
        break
      case 'properties':
        if (properties) out.properties = properties
        break
      case 'required':
        if (required) out.required = required
        break
      case 'items':
      case 'prefixItems':
        if (items && !hasOwn(out, 'items')) out.items = items
        break
      case 'minItems':
      case 'maxItems':
        if (type === 'array' && isCount(node[key])) out[key] = node[key]
        break
      case 'minLength':
      case 'maxLength':
        if (type === 'string' && isCount(node[key])) out[key] = node[key]
        break
      case 'minimum':
      case 'maximum':
        if (numeric && isFiniteNumber(node[key])) out[key] = node[key]
        break
    }
  }
  if (type && !hasOwn(out, 'type')) out.type = type
  if (description !== undefined && !hasOwn(out, 'description')) out.description = description
  if (nullable && !hasOwn(out, 'nullable')) out.nullable = true
  if (enumOut && enumOut.length > 0 && !hasOwn(out, 'enum')) out.enum = enumOut
  if (properties && !hasOwn(out, 'properties')) out.properties = properties
  if (required && !hasOwn(out, 'required')) out.required = required
  if (items && !hasOwn(out, 'items')) out.items = items
  return out
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Convert a tool's input schema into Gemini function-declaration
 * `parameters`. Always returns an object schema (function-call arguments are
 * a JSON object, and Claude via Antigravity requires `type: "object"`).
 */
export function sanitizeGeminiToolParameters(schema: unknown): SchemaObject {
  const ctx: Ctx = { root: schema, refStack: [], budget: GEMINI_SCHEMA_MAX_NODES }
  const out = convert(schema, ctx, 0)
  if (out.type !== 'object') return { type: 'object', properties: {} }
  if (!hasOwn(out, 'nullable')) return out
  const { nullable: _nullable, ...rest } = out
  return rest
}

/**
 * Tool names both validators accept: Gemini needs a letter or underscore
 * first and allows up to 128 characters; Claude via Antigravity forbids the
 * dots and colons Gemini would otherwise allow.
 */
const GEMINI_TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/

/**
 * Deterministic wire name for a tool. Valid names (every built-in and every
 * normal MCP tool) come back unchanged. Names that only need a leading
 * letter get the historical `t_` prefix; anything else is sanitized and
 * suffixed with a hash of the original so two names cannot collide.
 */
export function geminiSafeToolName(name: string): string {
  if (GEMINI_TOOL_NAME_RE.test(name)) return name
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  const base = /^[a-zA-Z_]/.test(replaced) ? replaced : `t_${replaced}`
  if (base === `t_${name}` && GEMINI_TOOL_NAME_RE.test(base)) return base
  const suffix = `_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
  return `${base.slice(0, 128 - suffix.length)}${suffix}`
}

/**
 * List every way `parameters` breaks the rules above. Empty means the
 * schema is safe to send. Used by tests and live verification.
 */
export function findGeminiSchemaViolations(parameters: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(parameters)) return ['root: not an object']
  if (parameters.type !== 'object') problems.push('root: type must be "object"')
  if (hasOwn(parameters, 'nullable')) problems.push('root: must not be nullable')
  const visit = (node: unknown, path: string, depth: number): void => {
    if (!isRecord(node)) {
      problems.push(`${path}: schema is not an object`)
      return
    }
    if (depth > GEMINI_SCHEMA_MAX_DEPTH + 1) problems.push(`${path}: nested deeper than ${GEMINI_SCHEMA_MAX_DEPTH + 1}`)
    for (const key of Object.keys(node)) {
      if (!OUTPUT_KEYS.has(key)) problems.push(`${path}.${key}: field not accepted`)
    }
    const type = node.type
    if (type !== undefined && !(typeof type === 'string' && SCHEMA_TYPES.has(type))) problems.push(`${path}.type: invalid ${JSON.stringify(type)}`)
    if (hasOwn(node, 'description') && typeof node.description !== 'string') problems.push(`${path}.description: not a string`)
    if (hasOwn(node, 'format') && typeof node.format !== 'string') problems.push(`${path}.format: not a string`)
    if (hasOwn(node, 'nullable') && typeof node.nullable !== 'boolean') problems.push(`${path}.nullable: not a boolean`)
    if (hasOwn(node, 'enum')) {
      if (type !== 'string') problems.push(`${path}.enum: only emitted on strings`)
      if (!Array.isArray(node.enum) || !node.enum.every(v => typeof v === 'string')) problems.push(`${path}.enum: entries must be strings`)
    }
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
      if (hasOwn(node, key) && !isCount(node[key])) problems.push(`${path}.${key}: not a non-negative integer`)
    }
    for (const key of ['minimum', 'maximum']) {
      if (hasOwn(node, key) && !isFiniteNumber(node[key])) problems.push(`${path}.${key}: not a finite number`)
    }
    if ((hasOwn(node, 'minItems') || hasOwn(node, 'maxItems')) && type !== 'array') problems.push(`${path}: item counts outside an array`)
    if ((hasOwn(node, 'minLength') || hasOwn(node, 'maxLength')) && type !== 'string') problems.push(`${path}: length bounds outside a string`)
    if (type === 'array') {
      if (!hasOwn(node, 'items')) problems.push(`${path}.items: missing on array`)
    } else if (hasOwn(node, 'items')) {
      problems.push(`${path}.items: only allowed on arrays`)
    }
    if (hasOwn(node, 'items')) visit(node.items, `${path}.items`, depth + 1)
    if (hasOwn(node, 'properties')) {
      if (type !== 'object') problems.push(`${path}.properties: only allowed on objects`)
      if (!isRecord(node.properties)) {
        problems.push(`${path}.properties: not a map`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          if (key === '') problems.push(`${path}.properties: empty property name`)
          visit(child, `${path}.properties[${key}]`, depth + 1)
        }
      }
    }
    if (hasOwn(node, 'required')) {
      if (type !== 'object') problems.push(`${path}.required: only allowed on objects`)
      const props = isRecord(node.properties) ? node.properties : {}
      const list = Array.isArray(node.required) ? node.required : []
      if (!Array.isArray(node.required) || list.length === 0) problems.push(`${path}.required: must be a non-empty list`)
      if (new Set(list).size !== list.length) problems.push(`${path}.required: duplicate entries`)
      for (const name of list) {
        if (typeof name !== 'string' || !hasOwn(props, name)) problems.push(`${path}.required: ${JSON.stringify(name)} is not a property`)
      }
    }
  }
  visit(parameters, 'parameters', 0)
  return problems
}
