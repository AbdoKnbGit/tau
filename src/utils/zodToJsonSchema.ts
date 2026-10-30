/**
 * Converts Zod v4 schemas to JSON Schema using native toJSONSchema.
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() runs this for every tool on every API request (~60-250
// times/turn). Tool schemas are wrapped with lazySchema() which guarantees the
// same ZodTypeAny reference per session, so we can cache by identity.
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

// Members of these are names or plain values, not schema keywords.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions'])
const PLAIN_VALUES = new Set(['const', 'default', 'enum', 'examples'])

/**
 * Newer zod writes some unions as a type array or oneOf, and puts description
 * later. Tool definitions are part of the prompt cache key, and provider schema
 * subsets differ on those union forms, so the spelling stays fixed: plain anyOf
 * unions, description first.
 */
function withStableSpelling(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withStableSpelling)
  if (schema === null || typeof schema !== 'object') return schema
  const entries = Object.entries(schema).map(([key, value]) => {
    if (PLAIN_VALUES.has(key)) return [key, value]
    if (SCHEMA_MAPS.has(key) && value !== null && typeof value === 'object') {
      return [
        key,
        Object.fromEntries(
          Object.entries(value).map(([name, member]) => [
            name,
            withStableSpelling(member),
          ]),
        ),
      ]
    }
    if (key === 'oneOf') return ['anyOf', withStableSpelling(value)]
    if (key === 'type' && Array.isArray(value)) {
      return ['anyOf', value.map(type => ({ type }))]
    }
    return [key, withStableSpelling(value)]
  })
  return Object.fromEntries(
    entries.sort(
      ([a], [b]) => Number(b === 'description') - Number(a === 'description'),
    ),
  )
}

/**
 * Converts a Zod v4 schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  const hit = cache.get(schema)
  if (hit) return hit
  const result = withStableSpelling(toJSONSchema(schema)) as JsonSchema7Type
  cache.set(schema, result)
  return result
}
