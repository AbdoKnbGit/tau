/**
 * Where a key in a JSON Schema is a keyword, and where it is a user's name.
 *
 * Every provider projection in Tau walks a tool's schema deleting keywords the
 * provider rejects. Several of those walks recursed into every object and
 * applied the deletion to every key, including inside `properties`, `$defs`
 * and `patternProperties` — maps whose keys are names the MCP server chose. A
 * tool with a parameter called `default`, `format` or `x-label` had that
 * parameter deleted from the declaration while `required` still named it, so
 * the model received a schema whose mandatory fields did not exist and had no
 * way to call the tool correctly.
 *
 * These sets say which keywords hold subschemas and in what shape, so a walk
 * can recurse by position instead of by guessing from the value's type.
 */

/**
 * Keywords whose value is a map from user-chosen names to subschemas.
 * Recurse into the values; never filter the keys.
 */
export const NAME_KEYED_SUBSCHEMA_MAPS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
])

/** Keywords whose value is a single subschema (or a boolean schema). */
export const SUBSCHEMA_VALUED: ReadonlySet<string> = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'unevaluatedItems',
  'unevaluatedProperties',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
])

/** Keywords whose value is an array of subschemas, in a meaningful order. */
export const SUBSCHEMA_LIST_VALUED: ReadonlySet<string> = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
])

/**
 * True when a key at schema position holds one or more subschemas — so a walk
 * must recurse into it. Everything else at schema position is data: an `enum`
 * member, a `const`, a `default` value, `examples`, `required`. Recursing into
 * those and deleting "keywords" would change the values the server receives.
 */
export function holdsSubschemas(key: string): boolean {
  return (
    NAME_KEYED_SUBSCHEMA_MAPS.has(key) ||
    SUBSCHEMA_VALUED.has(key) ||
    SUBSCHEMA_LIST_VALUED.has(key)
  )
}

/**
 * Walk a JSON Schema, applying `visitKeyword` to each key in schema position.
 *
 * `visitKeyword` returns the value to keep, or `undefined` to drop the key.
 * It is never called for a key inside a name-keyed map, so a property named
 * like a keyword is never mistaken for one.
 */
export function walkSchemaByPosition(
  node: unknown,
  visitKeyword: (
    key: string,
    value: unknown,
    recurse: (child: unknown) => unknown,
  ) => unknown,
): unknown {
  const recurse = (child: unknown): unknown =>
    walkSchemaByPosition(child, visitKeyword)

  if (Array.isArray(node)) return node.map(recurse)
  if (!node || typeof node !== 'object') return node

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const kept = visitKeyword(key, value, child => {
      if (NAME_KEYED_SUBSCHEMA_MAPS.has(key)) return walkNameKeyedMap(child, recurse)
      if (SUBSCHEMA_LIST_VALUED.has(key)) {
        return Array.isArray(child) ? child.map(recurse) : child
      }
      if (SUBSCHEMA_VALUED.has(key)) {
        // `additionalProperties: true|false` is a boolean schema, not an
        // object to walk.
        return child && typeof child === 'object' ? recurse(child) : child
      }
      // Data. Returned exactly as the server wrote it.
      return child
    })
    if (kept !== undefined) out[key] = kept
  }
  return out
}

function walkNameKeyedMap(
  node: unknown,
  recurse: (child: unknown) => unknown,
): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const out: Record<string, unknown> = {}
  for (const [name, subschema] of Object.entries(
    node as Record<string, unknown>,
  )) {
    out[name] =
      subschema && typeof subschema === 'object' ? recurse(subschema) : subschema
  }
  return out
}
