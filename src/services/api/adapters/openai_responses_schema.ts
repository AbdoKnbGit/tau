/**
 * OpenAI Responses function-tool schema helpers.
 *
 * Responses strict mode requires every object to set
 * additionalProperties:false, and every declared property to be listed in
 * required. Optional properties are represented as nullable fields.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNSUPPORTED_RESPONSES_SCHEMA_FIELDS = new Set([
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

export function sanitizeResponsesToolParametersForOpenAI(schema: unknown): Record<string, unknown> {
  const sanitized = sanitizeResponsesToolSchemaValue(schema)
  return isRecord(sanitized)
    ? sanitized
    : { type: 'object', properties: {} }
}

function sanitizeResponsesToolSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeResponsesToolSchemaValue(item))
  }

  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_RESPONSES_SCHEMA_FIELDS.has(key)) continue
    if (key.startsWith('x-')) continue
    if (child === undefined) continue
    if (key === 'properties' && isRecord(child)) {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeResponsesToolSchemaValue(propertySchema),
        ]),
      )
      continue
    }
    if (key === 'type') {
      const normalizedType = sanitizeSchemaTypeKeyword(child)
      if (normalizedType !== undefined) out.type = normalizedType
      continue
    }
    out[key] = sanitizeResponsesToolSchemaValue(child)
  }
  return out
}

function sanitizeSchemaTypeKeyword(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined

  const types: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      types.push(item)
      continue
    }
    if (isRecord(item)) {
      const nested = sanitizeSchemaTypeKeyword(item.type)
      if (Array.isArray(nested)) types.push(...nested)
      else if (nested) types.push(nested)
    }
  }

  const unique = [...new Set(types)]
  if (unique.length === 0) return undefined
  return unique.length === 1 ? unique[0] : unique
}

export function toOpenAIStrictToolParameters(
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  const cloned = cloneStrictCompatibleSchema(schema)
  return isRecord(cloned) ? cloned : null
}

function cloneStrictCompatibleSchema(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) {
      const cloned = cloneStrictCompatibleSchema(item)
      if (cloned === null) return null
      items.push(cloned)
    }
    return items
  }

  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}

  const type = normalizeJsonSchemaType(value.type)
  const properties = isRecord(value.properties) ? value.properties : undefined
  const isObjectSchema = type === 'object' || properties !== undefined

  if (isObjectSchema) {
    const clonedProperties: Record<string, unknown> = {}
    const propertyNames = Object.keys(properties ?? {})
    const required = Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === 'string')
      : []

    for (const [propertyName, child] of Object.entries(properties ?? {})) {
      const cloned = cloneStrictCompatibleSchema(child)
      if (cloned === null) return null
      clonedProperties[propertyName] = required.includes(propertyName)
        ? cloned
        : makeSchemaNullable(cloned)
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' || key === 'required' || key === 'additionalProperties') continue
      const cloned = cloneStrictCompatibleSchema(child)
      if (cloned === null) return null
      out[key] = cloned
    }

    out.type = type ?? 'object'
    out.properties = clonedProperties
    out.required = propertyNames
    out.additionalProperties = false
    return out
  }

  for (const [key, child] of Object.entries(value)) {
    const cloned = cloneStrictCompatibleSchema(child)
    if (cloned === null) return null
    out[key] = cloned
  }

  return out
}

function normalizeJsonSchemaType(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter((item): item is string =>
      typeof item === 'string' && item !== 'null')
    return nonNull[0]
  }
  return undefined
}

function makeSchemaNullable(schema: unknown): unknown {
  if (!isRecord(schema)) return schema

  const out = { ...schema }
  const type = out.type
  if (typeof type === 'string') {
    out.type = type === 'null' ? type : [type, 'null']
    return out
  }
  if (Array.isArray(type)) {
    out.type = type.includes('null') ? type : [...type, 'null']
    return out
  }
  if (Array.isArray(out.anyOf)) {
    const hasNull = out.anyOf.some(item => isRecord(item) && item.type === 'null')
    out.anyOf = hasNull ? out.anyOf : [...out.anyOf, { type: 'null' }]
  }
  return out
}
