/**
 * Codex lane: tool parameter schemas for OpenAI's Responses API.
 *
 * Every function tool is sent the way native Codex (codex-rs) sends all of
 * its tools: `strict: false`, with the tool's own schema. Strict mode cannot
 * say "optional": it makes every field required-or-null, and models then fill
 * optional fields with guesses (a worktree nobody asked for, a document engine
 * the server refuses) instead of leaving them out. Tau validates every call
 * against the tool's full schema before running it, so a bad call still comes
 * back as an error the model can fix.
 *
 * What goes on the wire is the tool's contract: local `$ref`s inlined (so the
 * model sees the structure instead of an opaque reference), metadata the model
 * does not need left out, and malformed keywords repaired, so the whole tool
 * block passes the backend's schema check. It never narrows the tool and never
 * invents structure: an array whose items are unspecified stays unspecified.
 *
 * Rules measured against the live ChatGPT Codex backend on 2026-09-26. With
 * `strict: false` the backend only meta-validates the schema:
 *   - the root must be an object schema (untyped is accepted)
 *   - `type` is a known name or a non-empty list of unique known names
 *   - `required` is a list of unique strings; `properties` maps names to
 *     schemas; `items` and `additionalProperties` are an object or boolean;
 *     `anyOf`/`oneOf`/`allOf` are non-empty lists
 *   - counts are non-negative integers; `description`, `format` and `$ref` are
 *     strings; `pattern` must compile as a (Python) regex
 * Everything else is accepted: arrays without `items`, `{}`, maps, tuples,
 * `oneOf`/`allOf`/`not`, dangling `$ref`s, unknown keywords.
 *
 * Determinism is a hard requirement: the tool block is part of the cached
 * prompt prefix, so the same input must always give byte-identical output.
 * This is a pure function of its input, keeps the input's key order, never
 * mutates it, and is idempotent.
 */

type SchemaObject = Record<string, unknown>

const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/**
 * Keywords left off the wire: identifiers, metadata the model does not need,
 * and validation the backend checks with a different regex dialect (a
 * JavaScript `pattern` can be refused). Native Codex drops the same ones. Tau
 * still validates every call against the tool's full schema.
 */
const OMITTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$comment',
  '$defs',
  'definitions',
  'strict',
  'format',
  'pattern',
  'default',
  'examples',
  'const',
  'title',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedItems',
  'prefixItems',
  'contains',
  'minContains',
  'maxContains',
])

const COUNT_KEYWORDS = new Set([
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties',
  'maxProperties', 'minContains', 'maxContains',
])
const NUMBER_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])
const SCHEMA_LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf'])
const SINGLE_SCHEMA_KEYWORDS = new Set([
  'not', 'if', 'then', 'else', 'contains', 'propertyNames',
  'unevaluatedProperties', 'unevaluatedItems', 'additionalItems',
])

/** Nodes emitted per tool while inlining `$ref`s, so a ref graph cannot fan out without bound. */
const MAX_NORMALIZED_NODES = 1500

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

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// ─── Normalization ───────────────────────────────────────────────

interface NormalizeCtx {
  root: unknown
  /** `$ref`s being expanded on the current path, for cycle detection. */
  refStack: string[]
  budget: number
}

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

/** One type name, lower-cased when that makes it a JSON Schema type. */
function normalizeTypeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (JSON_SCHEMA_TYPES.has(value)) return value
  const lowered = value.toLowerCase()
  return JSON_SCHEMA_TYPES.has(lowered) ? lowered : undefined
}

/**
 * `type` as the meta-schema accepts it: one known name, or a list of unique
 * known names. A list entry that is itself a schema contributes its type (a
 * shape some generators emit). Unknown names are dropped; the node is then
 * untyped, which is what an unusable type annotation amounts to.
 */
function normalizeTypeKeyword(value: unknown): string | string[] | undefined {
  if (!Array.isArray(value)) return normalizeTypeName(value)
  const types: string[] = []
  for (const item of value) {
    const nested = isRecord(item) ? normalizeTypeKeyword(item.type) : normalizeTypeName(item)
    if (Array.isArray(nested)) types.push(...nested)
    else if (nested) types.push(nested)
  }
  const unique = [...new Set(types)]
  if (unique.length === 0) return undefined
  return unique.length === 1 ? unique[0] : unique
}

function typeList(type: unknown): string[] {
  if (typeof type === 'string') return [type]
  return Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : []
}

/** A schema-valued position: records are normalized, booleans kept, junk made permissive. */
function normalizeSchemaValue(value: unknown, ctx: NormalizeCtx): SchemaObject | boolean {
  if (typeof value === 'boolean') return value
  if (isRecord(value)) return normalizeNode(value, ctx)
  // A bare type name where a schema belongs (`items: "string"`).
  const type = normalizeTypeName(value)
  return type ? { type } : {}
}

function normalizeSchemaList(value: unknown, ctx: NormalizeCtx): Array<SchemaObject> | undefined {
  if (!Array.isArray(value)) return undefined
  const out: SchemaObject[] = []
  for (const item of value) {
    const normalized = normalizeSchemaValue(item, ctx)
    // `true` allows anything; `false` can never match, so it adds nothing to a union.
    if (normalized === true) out.push({})
    else if (normalized !== false) out.push(normalized)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Follow a node's own `$ref` chain. Siblings of `$ref` apply on top of the
 * target (JSON Schema 2020-12), so the node's description wins over the
 * referenced definition's. A ref back into the current path keeps only the
 * target's type and description: the recursion cannot be inlined, and a
 * typed node without the recursive part is still a truthful superset.
 * Unresolvable refs (external URLs, anchors, dangling pointers) are dropped
 * and the siblings kept.
 */
function deref(input: SchemaObject, ctx: NormalizeCtx, followed: string[]): SchemaObject {
  let node = input
  for (let hop = 0; hop < 32 && typeof node.$ref === 'string'; hop++) {
    const ref = node.$ref
    const { $ref: _ref, ...siblings } = node
    const target = resolvePointer(ctx.root, ref)
    if (ctx.refStack.includes(ref) || followed.includes(ref)) {
      if (!isRecord(target)) return siblings
      const shallow: SchemaObject = {}
      const type = normalizeTypeKeyword(target.type)
      if (type !== undefined) shallow.type = type
      if (typeof target.description === 'string') shallow.description = target.description
      return { ...shallow, ...siblings }
    }
    followed.push(ref)
    node = isRecord(target) ? { ...target, ...siblings } : siblings
  }
  if (hasOwn(node, '$ref')) {
    const { $ref: _ref, ...rest } = node
    node = rest
  }
  return node
}

function normalizeNode(input: SchemaObject, ctx: NormalizeCtx): SchemaObject {
  ctx.budget--
  const followed: string[] = []
  const node = typeof input.$ref === 'string' ? deref(input, ctx, followed) : input
  if (ctx.budget <= 0) {
    // Out of budget: keep the node's own type and description only.
    const shallow: SchemaObject = {}
    const type = normalizeTypeKeyword(node.type)
    if (type !== undefined) shallow.type = type
    if (typeof node.description === 'string') shallow.description = node.description
    return shallow
  }
  ctx.refStack.push(...followed)
  try {
    return normalizeKeywords(node, ctx)
  } finally {
    ctx.refStack.length -= followed.length
  }
}

function normalizeKeywords(node: SchemaObject, ctx: NormalizeCtx): SchemaObject {
  const out: SchemaObject = {}
  const hoistedRequired: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue
    switch (key) {
      case 'type': {
        const type = normalizeTypeKeyword(value)
        if (type !== undefined) out.type = type
        break
      }
      case 'properties': {
        if (!isRecord(value)) break
        const properties: SchemaObject = {}
        for (const [name, child] of Object.entries(value)) {
          // A property whose schema is `false` can never be supplied.
          if (child === false) continue
          // Draft-3 marked a property required on the property itself.
          if (isRecord(child) && child.required === true) hoistedRequired.push(name)
          const normalized = normalizeSchemaValue(child, ctx)
          setOwn(properties, name, normalized === true ? {} : normalized)
        }
        out.properties = properties
        break
      }
      case 'required': {
        if (!Array.isArray(value)) break
        const seen = new Set<string>()
        out.required = value.filter((name): name is string => {
          if (typeof name !== 'string' || seen.has(name)) return false
          seen.add(name)
          return true
        })
        break
      }
      case 'items': {
        if (Array.isArray(value)) {
          out.items = value.map(item => {
            const normalized = normalizeSchemaValue(item, ctx)
            return normalized === true ? {} : normalized
          })
        } else {
          const normalized = normalizeSchemaValue(value, ctx)
          out.items = normalized === true ? {} : normalized
        }
        break
      }
      case 'prefixItems': {
        const list = normalizeSchemaList(value, ctx)
        if (list) out.prefixItems = list
        break
      }
      case 'additionalProperties': {
        if (typeof value === 'boolean') out.additionalProperties = value
        else if (isRecord(value)) out.additionalProperties = normalizeNode(value, ctx)
        break
      }
      case 'patternProperties':
      case 'dependentSchemas': {
        if (!isRecord(value)) break
        const map: SchemaObject = {}
        for (const [name, child] of Object.entries(value)) setOwn(map, name, normalizeSchemaValue(child, ctx))
        out[key] = map
        break
      }
      case 'enum': {
        out.enum = Array.isArray(value) ? value : [value]
        break
      }
      case 'const': {
        // `const: x` is `enum: [x]`: the model still sees the one allowed
        // value when the metadata keywords are left out.
        if (!hasOwn(node, 'enum')) out.enum = [value]
        break
      }
      case 'nullable':
        // OpenAPI's `nullable: true` is applied to `type` / `enum` below.
        break
      case 'description':
      case 'format':
      case '$comment':
        if (typeof value === 'string') out[key] = value
        break
      default: {
        if (SCHEMA_LIST_KEYWORDS.has(key)) {
          const list = normalizeSchemaList(value, ctx)
          if (list) out[key] = list
        } else if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
          if (typeof value === 'boolean' || isRecord(value)) out[key] = normalizeSchemaValue(value, ctx)
        } else if (COUNT_KEYWORDS.has(key)) {
          if (isCount(value)) out[key] = value
        } else if (NUMBER_KEYWORDS.has(key)) {
          const repaired = normalizeNumberKeyword(key, value, node)
          if (repaired !== undefined) out[key] = repaired
        } else {
          setOwn(out, key, value)
        }
      }
    }
  }

  if (hoistedRequired.length > 0) {
    const required = Array.isArray(out.required) ? (out.required as string[]) : []
    out.required = [...new Set([...required, ...hoistedRequired])]
  }
  // Draft-4 boolean exclusive bounds moved onto the bound itself.
  if (node.exclusiveMinimum === true && hasOwn(out, 'minimum')) delete out.minimum
  if (node.exclusiveMaximum === true && hasOwn(out, 'maximum')) delete out.maximum

  if (node.nullable === true) applyNullable(out)
  return out
}

function normalizeNumberKeyword(key: string, value: unknown, node: SchemaObject): number | undefined {
  if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
    if (isFiniteNumber(value)) return value
    // Draft 4: `exclusiveMinimum: true` qualifies `minimum`.
    const bound = key === 'exclusiveMinimum' ? node.minimum : node.maximum
    return value === true && isFiniteNumber(bound) ? bound : undefined
  }
  if (key === 'multipleOf') return isFiniteNumber(value) && value > 0 ? value : undefined
  return isFiniteNumber(value) ? value : undefined
}

/** OpenAPI `nullable: true`, spelled the JSON Schema way. */
function applyNullable(node: SchemaObject): void {
  const type = node.type
  if (typeof type === 'string') {
    if (type !== 'null') node.type = [type, 'null']
  } else if (Array.isArray(type)) {
    if (!type.includes('null')) node.type = [...type, 'null']
  } else if (Array.isArray(node.anyOf)) {
    if (!node.anyOf.some(branch => isRecord(branch) && branch.type === 'null')) node.anyOf = [...node.anyOf, { type: 'null' }]
  }
  if (Array.isArray(node.enum) && !node.enum.includes(null)) node.enum = [...node.enum, null]
}

// ─── Contract ────────────────────────────────────────────────────

function stripForWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripForWire)
  if (!isRecord(value)) return value
  const out: SchemaObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (OMITTED_KEYWORDS.has(key) || key.startsWith('x-') || child === undefined) continue
    if (key === 'properties' && isRecord(child)) {
      const properties: SchemaObject = {}
      for (const [name, schema] of Object.entries(child)) setOwn(properties, name, stripForWire(schema))
      out.properties = properties
      continue
    }
    // Enum entries are values, not schemas: an object value keeps its keys.
    setOwn(out, key, key === 'enum' ? child : stripForWire(child))
  }
  return out
}

/**
 * A tool's input schema as the Codex lane sends it (`strict: false`): the
 * tool's own contract, cleaned for the backend's schema check. Also what the
 * STRICT PARAMETERS description hint reads, so optional stays optional there.
 */
export function toCodexToolParameters(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: 'object', properties: {} }
  const ctx: NormalizeCtx = { root: schema, refStack: [], budget: MAX_NORMALIZED_NODES }
  const normalized = normalizeNode(schema, ctx)
  // Function arguments are always a JSON object, and the backend rejects any
  // other root type, a list included. A root declaring no object type at all
  // is unusable as-is.
  const types = typeList(normalized.type)
  if (types.length > 0 && !types.includes('object')) return { type: 'object', properties: {} }
  if (types.length > 1) normalized.type = 'object'
  return stripForWire(normalized) as Record<string, unknown>
}

// ─── Validator (tests and live verification) ─────────────────────

/**
 * Every way `parameters` breaks the backend's schema check above. Empty means
 * the schema is safe to send with `strict: false`.
 */
export function findCodexToolSchemaViolations(parameters: unknown): string[] {
  const problems: string[] = []
  if (!isRecord(parameters)) return ['parameters: not an object']
  if (parameters.type !== undefined && parameters.type !== 'object') problems.push('parameters: root type must be "object"')
  const visitSchema = (node: unknown, path: string): void => {
    if (typeof node === 'boolean') return
    if (!isRecord(node)) {
      problems.push(`${path}: schema is not an object or boolean`)
      return
    }
    if (hasOwn(node, 'type')) {
      const type = node.type
      const list = Array.isArray(type) ? type : [type]
      if (list.length === 0 || !list.every(item => typeof item === 'string' && JSON_SCHEMA_TYPES.has(item))) {
        problems.push(`${path}.type: invalid ${JSON.stringify(type)}`)
      } else if (new Set(list).size !== list.length) {
        problems.push(`${path}.type: duplicate entries`)
      }
    }
    if (hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || !required.every(item => typeof item === 'string')) problems.push(`${path}.required: not a list of strings`)
      else if (new Set(required).size !== required.length) problems.push(`${path}.required: duplicate entries`)
    }
    if (hasOwn(node, 'enum') && !Array.isArray(node.enum)) problems.push(`${path}.enum: not a list`)
    for (const key of ['description', 'format', '$ref']) {
      if (hasOwn(node, key) && typeof node[key] !== 'string') problems.push(`${path}.${key}: not a string`)
    }
    for (const key of COUNT_KEYWORDS) {
      if (hasOwn(node, key) && !isCount(node[key])) problems.push(`${path}.${key}: not a non-negative integer`)
    }
    for (const key of NUMBER_KEYWORDS) {
      if (hasOwn(node, key) && !isFiniteNumber(node[key])) problems.push(`${path}.${key}: not a number`)
    }
    if (hasOwn(node, 'pattern')) problems.push(`${path}.pattern: regex dialects differ; left to the local validator`)
    if (hasOwn(node, 'properties')) {
      if (!isRecord(node.properties)) problems.push(`${path}.properties: not a map`)
      else for (const [name, child] of Object.entries(node.properties)) visitSchema(child, `${path}.properties[${name}]`)
    }
    if (hasOwn(node, 'items')) {
      const items = node.items
      if (Array.isArray(items)) items.forEach((item, i) => visitSchema(item, `${path}.items[${i}]`))
      else visitSchema(items, `${path}.items`)
    }
    if (hasOwn(node, 'additionalProperties')) visitSchema(node.additionalProperties, `${path}.additionalProperties`)
    for (const key of SCHEMA_LIST_KEYWORDS) {
      if (!hasOwn(node, key)) continue
      const list = node[key]
      if (!Array.isArray(list) || list.length === 0) problems.push(`${path}.${key}: not a non-empty list`)
      else list.forEach((item, i) => visitSchema(item, `${path}.${key}[${i}]`))
    }
    for (const key of SINGLE_SCHEMA_KEYWORDS) {
      if (hasOwn(node, key)) visitSchema(node[key], `${path}.${key}`)
    }
  }
  visitSchema(parameters, 'parameters')
  return problems
}
