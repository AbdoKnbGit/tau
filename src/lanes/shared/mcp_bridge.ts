/**
 * Shared MCP bridge.
 *
 * MCP servers expose tools via JSON-Schema 2020-12. Each lane's provider
 * accepts a *subset* of that schema vocabulary — requesting unsupported
 * keywords trips 400s at varying points in the pipeline, quietly breaks
 * tool-calling on some models, or produces tools the model can't actually
 * invoke because the schema shape is foreign.
 *
 * This module is the single place where we normalize MCP tool schemas
 * into each lane's accepted subset. Adding a new lane = add one row to
 * the strip-list map.
 *
 * Reference behaviors:
 *   - gemini-cli's mcp-tool.ts sanitizer (Gemini subset)
 *   - codex-rs/codex-mcp/src/mcp_tool_names.rs (Responses API subset)
 *   - litellm/groq + claude-code-router/groq transformers (Groq subset)
 *   - OpenAI strict-mode tool-schema restrictions
 */

import type { ProviderTool } from '../../services/api/providers/base_provider.js'

export type LaneSchemaProfile =
  | 'gemini'
  | 'codex'
  | 'kiro'
  | 'anthropic'
  | 'openai-strict'
  | 'openai-loose'
  | 'glm'
  | 'groq'
  | 'mistral'
  | 'ollama'
  | 'qwen'
  | 'deepseek'
  | 'openrouter'
  | 'nim'
  | 'generic'

// Keywords each lane rejects on tool parameter schemas. Drop-lists based
// on field research: what the provider either 400s on or silently ignores
// in a way that breaks schema matching downstream.
//
// NOTE on Gemini: the full Gemini pipeline is more than a drop list —
// composition keywords (anyOf/oneOf/allOf, type arrays) must be
// FLATTENED before stripping, empty `required: []` must be removed, and
// the drop list has to be comprehensive enough to cover the full
// OpenAPI 3.0 subset Gemini accepts (type, format, description,
// nullable, enum, items, properties, required, minimum, maximum,
// minItems, maxItems, minLength, maxLength). The `gemini` profile
// below lists the DROPs used by the drop-list walk, but lanes should
// call `sanitizeSchemaForLane(..., 'gemini')` which internally routes
// through `sanitizeSchemaForGeminiDeep` to also do flattening. See that
// function below.
const DROP_BY_PROFILE: Record<LaneSchemaProfile, Set<string>> = {
  // Gemini: minimal JSON-Schema subset. Uppercase type enum enforced elsewhere.
  // Covers everything the legacy `anthropic_to_gemini:sanitizeSchemaForGemini`
  // drop list handled, so MCP tools with arbitrary JSON Schema don't 400.
  gemini: new Set([
    // JSON Schema identifiers & references
    '$schema', '$id', '$ref', '$comment', '$defs', 'definitions',
    // Composition keywords Gemini can't express (also handled by flatten)
    'not', 'if', 'then', 'else',
    // Object validation beyond properties/required
    'additionalProperties', 'patternProperties', 'propertyNames',
    'minProperties', 'maxProperties', 'unevaluatedProperties',
    'dependentRequired', 'dependentSchemas', 'strict',
    // Number validation beyond min/max
    'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
    // String validation (pattern is regex — Gemini doesn't accept it)
    'pattern', 'contentMediaType', 'contentEncoding',
    // Array validation beyond items/min/max
    'unevaluatedItems', 'prefixItems', 'contains', 'minContains', 'maxContains',
    // Metadata / validation fields Gemini rejects
    'default', 'const', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'title',
  ]),
  // Kiro / CodeWhisperer accepts JSON-schema-ish tool params but is picky
  // about meta keywords and strict-mode helpers that leak in from other lanes.
  // `additionalProperties` triggers "Improperly formed request" 400s on the
  // CodeWhisperer API — per the kiro-gateway reference implementation
  // (converters_core.sanitize_json_schema). Empty `required: []` arrays are
  // also rejected; those are handled conditionally in sanitizeSchemaForLane.
  kiro: new Set([
    '$schema', '$id', '$ref', '$comment',
    'strict', 'default', 'examples',
    'additionalProperties',
  ]),
  // Codex Responses API: accepts most JSON-Schema but rejects $schema/$id.
  codex: new Set(['$schema', '$id', '$ref', '$comment']),
  // Anthropic: passes most keywords through; strip a handful that confuse
  // the server validator in rare edge cases.
  anthropic: new Set(['$schema', '$id', '$ref', '$comment']),
  // OpenAI strict mode rejects additionalProperties=false+extra metadata.
  'openai-strict': new Set(['$schema', '$id', '$ref', '$comment', 'default']),
  'openai-loose': new Set(['$schema', '$id', '$ref', '$comment']),
  glm: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'format', 'default']),
  // Groq: actively fails on $schema in tool params; also strips strict.
  groq: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  // Mistral: grammar validator chokes on several keywords.
  mistral: new Set([
    '$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties',
    'format', 'examples', 'default',
  ]),
  ollama: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  qwen: new Set(['$schema', '$id', '$ref', '$comment', 'strict', 'additionalProperties']),
  deepseek: new Set(['$schema', '$id', '$ref', '$comment']),
  openrouter: new Set(['$schema', '$id', '$ref', '$comment']),
  nim: new Set(['$schema', '$id', '$ref', '$comment']),
  generic: new Set(['$schema', '$id', '$ref', '$comment', 'strict']),
}

/**
 * Sanitize a JSON Schema for the target lane. Returns a fresh object —
 * never mutates the input. Safe to call on MCP schemas before forwarding.
 *
 * For the `gemini` profile this routes through `sanitizeSchemaForGeminiDeep`
 * which additionally flattens composition keywords (anyOf/oneOf/allOf),
 * handles type arrays like `["string","null"]`, removes empty `required`
 * arrays, and recurses into properties/items. Drop-list walk alone is
 * insufficient because Gemini 400s on `const`, `anyOf`, etc. even when
 * the fields are nested deep inside a property schema.
 */
export function sanitizeSchemaForLane(
  schema: unknown,
  profile: LaneSchemaProfile,
): Record<string, unknown> {
  if (profile === 'gemini') {
    return sanitizeSchemaForGeminiDeep(schema)
  }
  const drop = DROP_BY_PROFILE[profile]
  // Kiro 400s on empty required arrays at any nesting level.
  const dropEmptyRequired = profile === 'kiro'
  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue
        if (
          dropEmptyRequired &&
          k === 'required' &&
          Array.isArray(value) &&
          value.length === 0
        ) continue
        out[k] = walk(value)
      }
      return out
    }
    return v
  }
  const result = walk(schema)
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { type: 'object', properties: {} }
  }
  return result as Record<string, unknown>
}

// ─── Gemini deep sanitizer ───────────────────────────────────────
//
// Gemini's tool-param schema follows OpenAPI 3.0 — a narrower subset
// of JSON Schema than most MCP servers emit. The drop-list walk alone
// misses: composition keywords that must be flattened, type arrays
// that must collapse to `type + nullable`, and empty `required: []`
// arrays that Gemini rejects.
//
// Ported from the legacy adapter at
// `src/services/api/adapters/anthropic_to_gemini.ts:sanitizeSchemaForGemini`
// which is battle-tested against real MCP tool schemas.

/**
 * Flatten JSON Schema composition keywords Gemini cannot express:
 *   - type arrays like ["string", "null"]  →  type: "string", nullable: true
 *   - anyOf / oneOf with a null branch     →  non-null branch + nullable
 *   - anyOf / oneOf without null           →  first branch
 *   - allOf                                 →  shallow-merge all branches
 * Runs BEFORE the drop-list strip so downstream walk cleans normally.
 */
function flattenComposition(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  if (Array.isArray(result.type)) {
    const types = result.type as string[]
    const nonNull = types.filter(t => t !== 'null')
    if (types.includes('null')) result.nullable = true
    result.type = nonNull.length === 1 ? nonNull[0] : nonNull[0] ?? 'string'
  }

  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = result[keyword] as Record<string, unknown>[] | undefined
    if (!Array.isArray(variants) || variants.length === 0) continue

    const nonNull = variants.filter(v => v && v.type !== 'null')
    const hasNull = variants.some(v => v && v.type === 'null')
    const picked = nonNull[0] ?? variants[0]!

    delete result[keyword]
    if (hasNull) result.nullable = true
    for (const [k, v] of Object.entries(picked)) {
      if (v !== undefined && !(k in result && k !== keyword)) {
        result[k] = v
      }
    }
  }

  if (Array.isArray(result.allOf)) {
    const branches = result.allOf as Record<string, unknown>[]
    delete result.allOf
    for (const branch of branches) {
      if (!branch) continue
      for (const [k, v] of Object.entries(branch)) {
        if (v === undefined) continue
        if (k === 'properties' && result.properties) {
          result.properties = {
            ...(result.properties as Record<string, unknown>),
            ...(v as Record<string, unknown>),
          }
        } else if (k === 'required' && result.required) {
          result.required = [
            ...new Set([
              ...(result.required as string[]),
              ...(v as string[]),
            ]),
          ]
        } else if (!(k in result)) {
          result[k] = v
        }
      }
    }
  }

  return result
}

// ─── Gemini tool-description hardening ───────────────────────────
//
// Even with a correct schema, Flash-class models occasionally emit
// tool calls with empty args (`{}`) — ignoring the `required[]` list.
// The legacy adapter mitigated this with two in-prompt reminders that
// we carry into the native lane:
//
//   1. A compact "STRICT PARAMETERS: a: string REQUIRED, b: number ..."
//      summary appended to each tool's description — tells the model
//      in plain text which fields are mandatory + their types.
//   2. A <TOOL_USAGE_RULES> system-instruction preamble reminding the
//      model that tool schemas override training-data memory.
//
// These are belt-and-suspenders with Gemini's server-side
// `toolConfig.functionCallingConfig.mode: "VALIDATED"` which Gemini
// enforces at response time (see lane request builder).

/**
 * Per-lane tool-usage preamble. Prepended to the system prompt (or
 * Codex `instructions`) whenever tools are present on a request.
 *
 * These exist because Flash/Qwen/Llama-class models regularly emit
 * tool calls with empty `{}` args, ignoring the schema. Server-side
 * schema enforcement (VALIDATED for Gemini, `strict: true` for OpenAI-
 * family tools) is the primary defense; the preamble is belt-and-
 * suspenders, tuned to each lane's native prompt tone so the cache key
 * stays stable and the addition feels native rather than bolted-on.
 *
 * Keep each preamble SHORT — every byte lands on every turn.
 */
export const GEMINI_TOOL_USAGE_RULES = `<TOOL_USAGE_RULES>
Tool schemas in this environment OVERRIDE your training-data memory of tool names.
Treat each tool's "parameters" field as authoritative:
- Use parameter NAMES exactly as listed in "properties" (case-sensitive).
- Supply EVERY parameter listed in "required" — never omit one, never send empty objects.
- Match parameter TYPES exactly (array means array, object means object, string means string).
- Do not invent extra parameters that are not in "properties".
The "STRICT PARAMETERS:" hint at the end of each tool description is your quick reference.

When a tool call fails, diagnose the cause — read the exit code/error text, verify what actually exists (binaries, paths, shell). Don't iterate cosmetic variants of the same call; blind retries waste input tokens. After two same-cause failures, stop and investigate. For unfamiliar CLIs, run \`--help\` once before invoking.
</TOOL_USAGE_RULES>
`

/**
 * Codex tool-usage rules. Matches Codex's concise native tone from the
 * captured system prompt — "tool calls are structured, follow schema
 * exactly, apply_patch is the edit primitive."
 */
export const CODEX_TOOL_USAGE_RULES = `<tool_use_rules>
Tool parameter schemas are authoritative. Never call a tool with missing required fields, never send empty arguments, never invent extra parameters. Parameter names are case-sensitive — copy them exactly from "properties". Match parameter types exactly (array means array, object means object, string means string).

Each tool description ends with a "STRICT PARAMETERS:" line listing required fields first. Use it as your quick reference before you emit the call.

For file edits, apply_patch is the primary edit primitive — use it for all in-place modifications. Use write_file only for brand-new files.

When a shell or tool call fails, diagnose first: exit code, error text, binary/path/shell. Make ONE focused fix; don't iterate cosmetic variants (swap shells, retry same path, tweak flags). Blind retries waste input tokens — if two attempts fail the same way, stop and investigate. For unfamiliar CLIs, check \`--help\` once before invoking.
</tool_use_rules>
`

/**
 * Kiro / CodeWhisperer tool-usage rules. Keep this short: Kiro doesn't have
 * server-side strict tool validation like Gemini VALIDATED mode, so the
 * prompt reminder does more of the enforcement work.
 */
export const KIRO_TOOL_USAGE_RULES = `<tool_usage_rules>
Tool schemas are authoritative. For every tool call:
- include every field listed in "required"
- use parameter names exactly as declared in "properties"
- match parameter types exactly
- do not send empty {} when fields are required
- if a tool description points to full documentation in the system prompt, read that section before calling the tool

The "STRICT PARAMETERS:" line in each tool description is the quick reference.

When a tool call fails, diagnose first — exit code, error text, what's actually available. Don't iterate cosmetic variants of the same call; blind retries waste input tokens. After two same-cause failures, stop and investigate. For unfamiliar CLIs, check \`--help\` before invoking.
</tool_usage_rules>
`

/**
 * Qwen tool-usage rules. Qwen3-Coder was the primary benchmark Qwen
 * shipped with — its post-training is especially strict about matching
 * schema field names. Extra nudge on case-sensitivity + required fields.
 */
export const QWEN_TOOL_USAGE_RULES = `<tool_usage>
Tool schemas are authoritative — they override anything you remember from training data about tool names or shapes.

Rules for every tool call:
- Include every parameter listed in "required". Never send {} when fields are required.
- Use parameter names EXACTLY as listed in "properties" (names are case-sensitive).
- Match parameter types exactly — if the schema says "array", send an array, not a string.
- Do not add parameters that aren't declared in "properties".

The "STRICT PARAMETERS:" line at the end of each description is the quick reference. Re-read it before each call.

When a command fails, diagnose first — read the exit code (127=not found, 2=misuse) and error text, verify what exists. Don't retry the same call with cosmetic tweaks; blind retries burn input tokens. After two same-cause failures, stop and investigate. For unfamiliar CLIs, run \`--help\` once instead of guessing flags.
</tool_usage>
`

/**
 * OpenAI-compatible lane rules. Covers DeepSeek, GLM, Groq, Mistral, NIM,
 * Ollama, OpenRouter + long tail. Kept general because the same text
 * ships to every provider.
 */
export const OPENAI_COMPAT_TOOL_USAGE_RULES = `<tool_usage_rules>
Tool parameter schemas are authoritative. Before every tool call:
- Fill in every parameter listed in "required". Never send empty {} when the schema requires fields.
- Use parameter names exactly as they appear in "properties" (case-sensitive).
- Match parameter types exactly (array means array, object means object, string means string).
- Don't invent parameters that aren't declared.

The "STRICT PARAMETERS:" line appended to each tool description summarizes required-vs-optional + types for quick reference.

When a tool call fails, diagnose first (exit code, error text, what actually exists) before retrying. Don't iterate cosmetic variants of the same call; blind retries burn input tokens. After two same-cause failures, stop and investigate. For unfamiliar CLIs/APIs, check \`--help\` once before invoking — don't guess flags.
</tool_usage_rules>
`

/**
 * Walk a parameter schema and emit a compact human-readable summary of
 * its properties + required flags. Used in tool descriptions.
 */
export function buildStrictParamsSummary(parameters: Record<string, unknown>): string {
  const typeStr = normalizeSchemaTypeForSummary(parameters.type)
  const properties = parameters.properties as Record<string, unknown> | undefined
  const required = Array.isArray(parameters.required)
    ? (parameters.required as unknown[]).filter((v): v is string => typeof v === 'string')
    : []

  if (typeStr !== 'object' || !properties) {
    return '(schema missing top-level object properties)'
  }

  const keys = Object.keys(properties)
  const requiredKeys = keys.filter(k => required.includes(k))
  const optionalKeys = keys.filter(k => !required.includes(k))
  const ordered = [...requiredKeys.sort(), ...optionalKeys.sort()]

  const summary = ordered
    .map(k => {
      const sub = summarizeSchemaNode(properties[k], 2)
      return `${k}: ${sub}${required.includes(k) ? ' REQUIRED' : ''}`
    })
    .join(', ')

  const max = 900
  return summary.length > max ? `${summary.slice(0, max)}…` : summary
}

function normalizeSchemaTypeForSummary(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const nonNull = value.filter(t => t !== 'null')
    const first = nonNull[0] ?? value[0]
    if (typeof first === 'string') return first
  }
  return undefined
}

function summarizeSchemaNode(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== 'object') return 'unknown'
  const record = schema as Record<string, unknown>
  const typeStr = normalizeSchemaTypeForSummary(record.type)
  const enumValues = Array.isArray(record.enum) ? (record.enum as unknown[]) : undefined

  if (typeStr === 'array') {
    const itemSummary = depth > 0 ? summarizeSchemaNode(record.items, depth - 1) : 'unknown'
    return `array[${itemSummary}]`
  }
  if (typeStr === 'object') {
    const props = record.properties as Record<string, unknown> | undefined
    const required = Array.isArray(record.required)
      ? (record.required as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    if (!props || depth <= 0) return 'object'
    const keys = Object.keys(props)
    const requiredKeys = keys.filter(k => required.includes(k))
    const optionalKeys = keys.filter(k => !required.includes(k))
    const ordered = [...requiredKeys.sort(), ...optionalKeys.sort()]
    const max = 8
    const shown = ordered.slice(0, max)
    const inner = shown
      .map(k => {
        const sub = summarizeSchemaNode(props[k], depth - 1)
        return `${k}: ${sub}${required.includes(k) ? ' REQUIRED' : ''}`
      })
      .join(', ')
    const extra = ordered.length - shown.length
    const more = extra > 0 ? `, …+${extra}` : ''
    return `{${inner}${more}}`
  }
  if (enumValues && enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map(String).join('|')
    const suffix = enumValues.length > 6 ? '|…' : ''
    return `${typeStr ?? 'unknown'} enum(${preview}${suffix})`
  }
  return typeStr ?? 'unknown'
}

/**
 * Append the STRICT PARAMETERS summary to a tool description, idempotently.
 * Call this on every Gemini function declaration.
 */
export function appendStrictParamsHint(
  description: string | undefined,
  parameters: Record<string, unknown>,
): string {
  const base = (description ?? '').trim()
  if (base.includes('STRICT PARAMETERS:')) return description ?? ''
  const summary = buildStrictParamsSummary(parameters)
  return base.length > 0
    ? `${base}\n\nSTRICT PARAMETERS: ${summary}`
    : `STRICT PARAMETERS: ${summary}`
}

function sanitizeSchemaForGeminiDeep(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} }
  }

  const flattened = flattenComposition(schema as Record<string, unknown>)
  const drop = DROP_BY_PROFILE.gemini
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flattened)) {
    if (drop.has(key)) continue
    if (value === undefined) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([propName, propSchema]) => [
            propName,
            propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
              ? sanitizeSchemaForGeminiDeep(propSchema)
              : propSchema,
          ]),
      )
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGeminiDeep(value)
    } else if (key === 'required' && Array.isArray(value)) {
      // Gemini rejects empty required arrays — only include if non-empty.
      if (value.length > 0) result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeSchemaForGeminiDeep(item)
          : item,
      )
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeSchemaForGeminiDeep(value)
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Normalize a MCP ProviderTool for a given lane. Returns a tool shape
 * compatible with that lane's tool registration format.
 *
 *   Gemini:  { name, description, parameters }
 *   Codex:   { type: 'function', name, description, parameters }
 *   Anthropic / compat: { name, description, input_schema }
 */
export function buildLaneTool(
  tool: ProviderTool,
  profile: LaneSchemaProfile,
): Record<string, unknown> {
  const cleanedSchema = sanitizeSchemaForLane(tool.input_schema ?? { type: 'object', properties: {} }, profile)

  switch (profile) {
    case 'gemini':
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: cleanedSchema,
      }
    case 'codex':
      return {
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: cleanedSchema,
      }
    default:
      // OpenAI Chat Completions + Anthropic Messages shape.
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: cleanedSchema,
        },
      }
  }
}

/**
 * MCP tool namespacing. Codex Rust uses `mcp_<server>_<tool>`;
 * gemini-cli uses the same. Keep the convention uniform across lanes
 * so a single dispatch map works regardless of which lane invokes.
 */
export const MCP_TOOL_PREFIX = 'mcp_'

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

export interface ParsedMcpToolName {
  server: string
  tool: string
}

export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (!isMcpToolName(name)) return null
  const body = name.slice(MCP_TOOL_PREFIX.length)
  const idx = body.indexOf('_')
  if (idx <= 0) return null
  return { server: body.slice(0, idx), tool: body.slice(idx + 1) }
}

export function buildMcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}_${tool}`
}
