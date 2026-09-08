/**
 * OpenAI strict-mode tool schemas on OpenRouter.
 *
 * Some upstreams behind OpenRouter run OpenAI's strict function-schema
 * validator, which is stricter than the Chat Completions shape everyone else
 * accepts. It demands that every object node carry `additionalProperties:
 * false` and a `required` array naming EVERY key in `properties`, and answers
 * a 400 otherwise:
 *
 *   'required' is required to be supplied and to be an array
 *   including every key in properties. Missing 'isolation'.
 *
 * Which upstreams do this is not something OpenRouter publishes, and it is not
 * a property of the model id either — it is a property of whoever serves the
 * row today. So this module learns it instead of listing it: OpenAI's own
 * families are recognised up front (they have always behaved this way), and
 * any other model that answers with that error is recorded, normalized, and
 * retried. The record persists, so the model is only ever wrong once.
 *
 * Normalizing is not free — a strict schema has no optional fields, so the
 * model must supply every parameter of every tool — which is why it stays
 * scoped to rows that actually demand it rather than being applied to all of
 * OpenRouter.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface OpenRouterStrictTool {
  function: {
    parameters: Record<string, unknown>
  }
}

export function normalizeOpenRouterGPTToolSchemas<T extends OpenRouterStrictTool>(
  tools: T[] | undefined,
  model: string,
): void {
  if (!tools?.length || !isStrictToolSchemaOnOpenRouter(model)) return
  for (const tool of tools) {
    tool.function.parameters = normalizeOpenAIStrictToolSchema(tool.function.parameters)
  }
}

export function isOpenAIStrictOnOpenRouter(model: string): boolean {
  const id = normalizeStrictModelKey(model)
  const local = id.startsWith('openai/') ? id.slice('openai/'.length) : id
  return /^(gpt-(?:4|5)|o[1-9]|chatgpt-)/.test(local)
}

/**
 * Whether this model's tool schemas must be normalized to OpenAI strict form —
 * either because it is an OpenAI family row, or because it has already told us
 * so once.
 */
export function isStrictToolSchemaOnOpenRouter(model: string): boolean {
  if (isOpenAIStrictOnOpenRouter(model)) return true
  loadLearnedStrictModels()
  return _learned.has(normalizeStrictModelKey(model))
}

/**
 * True when an OpenRouter error body is the strict-schema rejection above.
 *
 * Matched on the validator's own wording rather than on a status code or a
 * provider name: the same sentence comes back whichever upstream produced it,
 * and it is the only thing that identifies THIS failure rather than one of the
 * many other shapes a 400 can take.
 */
export function isOpenRouterStrictToolSchemaError(body: string): boolean {
  if (!body) return false
  return (
    /required to be supplied and to be an array including every key in properties/i.test(body)
    || /'additionalProperties' is required to be supplied and to be false/i.test(body)
  )
}

/**
 * Remember that this model needs strict tool schemas, so the next request —
 * this session's retry included — sends them without failing first.
 */
export function recordOpenRouterStrictToolSchemaModel(model: string): void {
  const key = normalizeStrictModelKey(model)
  if (!key) return
  loadLearnedStrictModels()
  if (_learned.has(key)) return
  _learned.add(key)
  saveLearnedStrictModels()
}

/**
 * OpenRouter's routing variants (`:free`, `:nitro`, `:floor`) select an
 * endpoint, not a different model, so they share one entry.
 */
function normalizeStrictModelKey(model: string): string {
  const id = model.trim().toLowerCase()
  const colon = id.indexOf(':')
  return colon > 0 ? id.slice(0, colon) : id
}

function strictStorePath(): string {
  return (
    process.env.TAU_OPENROUTER_STRICT_TOOLS_STORE
    || join(homedir(), '.claude', 'openrouter-strict-tools.json')
  )
}

let _learnedPath: string | null = null
let _learned = new Set<string>()

function loadLearnedStrictModels(): void {
  const path = strictStorePath()
  if (_learnedPath === path) return
  _learnedPath = path
  _learned = new Set()
  try {
    if (!existsSync(path)) return
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return
    for (const entry of parsed) {
      if (typeof entry === 'string' && entry.length > 0) {
        _learned.add(normalizeStrictModelKey(entry))
      }
    }
  } catch {
    // Stale or corrupt file — treat as empty. The next 400 re-learns the row.
  }
}

function saveLearnedStrictModels(): void {
  const path = strictStorePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify([..._learned].sort(), null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; the in-memory set still serves this session.
  }
}

/** Test-only: reset the learned set to a known state. */
export function _resetOpenRouterStrictToolSchemaForTests(
  models: readonly string[] = [],
): void {
  _learnedPath = strictStorePath()
  _learned = new Set(models.map(normalizeStrictModelKey))
}

export function normalizeOpenAIStrictToolSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeOpenAIStrictSchema(schema)
  return isPlainRecord(normalized) ? normalized : { type: 'object', properties: {}, required: [], additionalProperties: false }
}

function normalizeOpenAIStrictSchema(node: unknown): unknown {
  if (node === undefined) return undefined
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    const items = node
      .map(normalizeOpenAIStrictSchema)
      .filter(item => item !== undefined)
    return items
  }

  const obj = node as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (OPENAI_STRICT_SCHEMA_DROP_KEYS.has(key)) continue
    if (key.startsWith('x-')) continue

    if (key === 'properties') {
      const props = normalizeProperties(value)
      if (props) result.properties = props
      continue
    }

    const child = normalizeOpenAIStrictSchema(value)
    if (child !== undefined) result[key] = child
  }

  if (schemaNodeAllowsObject(result)) {
    const props = normalizeProperties(result.properties)
    result.properties = props ?? {}
    result.required = Object.keys(result.properties)
    result.additionalProperties = false
  } else if (result.type && !hasCombiner(result)) {
    delete result.properties
    delete result.required
    delete result.additionalProperties
  }

  return result
}

function normalizeProperties(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeOpenAIStrictSchema(child)
    if (normalized !== undefined) out[key] = normalizePropertySchema(normalized)
  }
  return out
}

function normalizePropertySchema(value: unknown): unknown {
  if (value === true) return { type: 'string' }
  if (value === false) return undefined
  if (!isPlainRecord(value)) return value
  if (hasSchemaIntent(value)) return value
  return { type: 'string' }
}

function schemaNodeAllowsObject(node: Record<string, unknown>): boolean {
  if (node.type === 'object') return true
  return Array.isArray(node.type) && node.type.includes('object')
}

function hasCombiner(node: Record<string, unknown>): boolean {
  return Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
}

function hasSchemaIntent(node: Record<string, unknown>): boolean {
  return (
    typeof node.type === 'string'
    || Array.isArray(node.type)
    || Array.isArray(node.enum)
    || hasCombiner(node)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const OPENAI_STRICT_SCHEMA_DROP_KEYS = new Set([
  '$schema', '$id', '$ref', '$comment', '$defs', 'definitions',
  'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'title',
  'patternProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'unevaluatedProperties', 'dependentRequired', 'dependentSchemas',
  'pattern', 'format', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'prefixItems', 'unevaluatedItems', 'contains', 'minContains', 'maxContains',
  'minItems', 'maxItems', 'uniqueItems',
  'contentMediaType', 'contentEncoding',
  'const', 'not', 'if', 'then', 'else',
])
