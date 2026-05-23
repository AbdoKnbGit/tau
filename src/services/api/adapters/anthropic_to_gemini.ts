/**
 * Outbound adapter: Converts Anthropic-format messages → Google Gemini generateContent format.
 *
 * Gemini uses a different structure:
 * - contents: array of {role: "user"|"model", parts: [{text}, {functionCall}, {functionResponse}]}
 * - tools: [{functionDeclarations: [...]}]
 * - systemInstruction: {parts: [{text}]}
 * - generationConfig: {maxOutputTokens, temperature}
 *
 * ── Tool-call reliability layers (in order of importance) ──────────
 *
 * Gemini tends to invent tool calls based on training-data memory of names
 * like `Agent`, `WebFetch`, `TaskCreate` — emitting calls with missing
 * required parameters. The fix is layered defense, ported from the
 * antigravity / CLIProxyAPI plugin in reference/opencode-google-antigravity-auth-main:
 *
 *   1. SERVER ENFORCEMENT (the actual fix):
 *      `toolConfig.functionCallingConfig.mode = "VALIDATED"`
 *      Gemini's API validates each functionCall against the declared
 *      parameters and retries internally on failure. Calls with missing
 *      required fields never reach us. Set unconditionally when tools
 *      are present.
 *
 *   2. SCHEMA SANITIZATION: `sanitizeSchemaForGemini` strips JSON-Schema
 *      keys Gemini rejects ($schema, additionalProperties, etc.) and
 *      flattens anyOf/oneOf/allOf composition. Without this Gemini 400s
 *      before any tool call is made.
 *
 *   3. TOOL NAME SANITIZATION: `sanitizeGeminiToolName` prefixes
 *      digit-leading names with `t_` (Gemini requires `^[a-zA-Z_]`).
 *      The reverse map lets inbound responses recover the original.
 *
 *   4. PER-TOOL HINT: `appendStrictParamsToDescription` writes a compact
 *      `STRICT PARAMETERS: name: type REQUIRED, …` line into each tool's
 *      description so the model has a one-glance schema reminder at call
 *      time without re-reading the full JSON.
 *
 *   5. SYSTEM-INSTRUCTION NUDGE: `GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION`
 *      a ~10-line block prepended to systemInstruction reminding the model
 *      to honor the schema instead of training-data memory. Kept short
 *      because it's on every turn — every byte costs latency on flash-lite.
 *
 *   6. SCHEMA CACHE FOR ARG REPAIR: each parameter shape is recorded by
 *      `recordToolSchema`. The inbound `gemini_to_anthropic` side calls
 *      `coerceToolCallArgs` to JSON.parse stringly-typed values when the
 *      schema declares array/object — covers the rare cases that escape
 *      VALIDATED mode (e.g. malformed-but-non-empty args).
 */

import type {
  ProviderRequestParams,
  ProviderMessage,
  ProviderContentBlock,
  ProviderTool,
  SystemBlock,
} from '../providers/base_provider.js'
import { getThoughtSignature } from './gemini_thought_cache.js'
import { recordToolSchema } from './tool_schema_cache.js'

/**
 * Gemini requires function names to match `^[a-zA-Z_][a-zA-Z0-9_-]*$`.
 * Names that start with a digit (some MCP tool conventions) get a `t_`
 * prefix; the same prefix is applied symmetrically when names come back
 * in functionCall/functionResponse so the tool dispatcher still resolves.
 */
export function sanitizeGeminiToolName(name: string): string {
  if (!name) return name
  return /^[0-9]/.test(name) ? `t_${name}` : name
}

const renamedToolMap = new Map<string, string>()

/** Records a tool name remapping so inbound responses can reverse it. */
export function rememberGeminiToolRename(original: string, sanitized: string): void {
  if (original !== sanitized) renamedToolMap.set(sanitized, original)
}

/** Reverses sanitizeGeminiToolName for inbound functionCall.name values. */
export function originalToolNameFromGemini(name: string): string {
  return renamedToolMap.get(name) ?? name
}

// ─── Gemini types ──────────────────────────────────────────────────

export interface GeminiSafetySettingEntry {
  category: string
  threshold: string
}

export interface GeminiRequest {
  contents: GeminiContent[]
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>
  /**
   * Controls how Gemini handles function calls. We force
   * `functionCallingConfig.mode = "VALIDATED"` whenever tools are present
   * so the API enforces the declared JSON schema server-side. Without this
   * the model frequently emits tool calls with missing required parameters
   * and the failures only surface in our local validator.
   */
  toolConfig?: {
    functionCallingConfig?: {
      mode?: 'AUTO' | 'ANY' | 'NONE' | 'VALIDATED'
      allowedFunctionNames?: string[]
    }
  }
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: {
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    stopSequences?: string[]
    thinkingConfig?: {
      thinkingBudget?: number
      includeThoughts?: boolean
    }
  }
  safetySettings?: GeminiSafetySettingEntry[]
  /**
   * Reference to a previously created `cachedContents/...` resource. When
   * set, `systemInstruction` and `tools` MUST be omitted — the cache
   * carries them. Used by the cache manager to reduce per-turn token cost
   * on repeated system prompts.
   */
  cachedContent?: string
}

// ─── Safety Settings ──────────────────────────────────────────────
// Identical to CLIProxyAPI's DefaultSafetySettings(): all harm categories
// set to OFF so Gemini doesn't block legitimate code content (error
// handling code, security tools, shell commands, etc.).

// ─── Safety Settings ──────────────────────────────────────────────
// Mirrors CLIProxyAPI's DefaultSafetySettings(). Without these, Gemini's
// default filters block legitimate code content (shell commands, security
// tools, error handling).  Disable with GEMINI_SAFETY=default.

function getGeminiSafetySettings(): GeminiSafetySettingEntry[] | undefined {
  if (process.env.GEMINI_SAFETY === 'default') return undefined
  return [
    { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'OFF' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY',    threshold: 'BLOCK_NONE' },
  ]
}

// ─── Dynamic Generation Config ────────────────────────────────────
//
// KEY INSIGHT from studying how Claude and Gemini CLI work:
//
// Claude's secret: `type: 'adaptive'` — NO fixed budget. The MODEL
// decides how much to think per turn. Simple tool calls = barely any
// thinking. Complex reasoning = lots of thinking. This is why Claude
// is fast on iterative tool loops.
//
// Gemini's equivalent: `thinkingBudget: -1` (dynamic mode). The model
// decides per-turn how much thinking to use. Same concept, same benefit.
//
// Previous approach (fixed 8K/24K budgets) forced the model to think
// the same amount on "Read file.ts" as on "design the architecture".
// Dynamic mode fixes this — the model spends 0 tokens thinking when
// it just needs to call the next tool, and 10K+ when it needs to reason.
//
// All values overridable via env:
//   GEMINI_TOP_P        — sampling (default: 0.95)
//   GEMINI_TOP_K        — sampling (default: 64)
//   GEMINI_THINKING     — thinking budget (0=off, -1=dynamic, N=fixed)
//   GEMINI_TEMPERATURE  — temperature override

function _envFloat(key: string): number | undefined {
  const v = process.env[key]
  if (!v) return undefined
  const n = parseFloat(v)
  return isNaN(n) ? undefined : n
}

function _envInt(key: string): number | undefined {
  const v = process.env[key]
  if (!v) return undefined
  const n = parseInt(v, 10)
  return isNaN(n) ? undefined : n
}

/**
 * Determine if a model supports thinking at all.
 * Flash-lite variants are speed-optimized and don't have thinking.
 */
function modelSupportsDynamicThinking(model: string): boolean {
  const m = model.toLowerCase()
  if (!m.startsWith('gemini-')) return false
  // Lite variants are speed-first, no thinking
  if (m.includes('lite')) return false
  // Gemini 2.5+ and 3.x all support thinking
  if (m.includes('gemini-2.5') || m.includes('gemini-3') || m.includes('gemini-4')) return true
  // Older/unknown — don't assume thinking
  return false
}

/**
 * Build the full generation defaults for a model.
 */
function getModelGenerationDefaults(model: string): {
  topP: number
  topK: number
  temperature: number | undefined
  supportsDynamicThinking: boolean
} {
  return {
    topP: _envFloat('GEMINI_TOP_P') ?? 0.95,
    topK: _envInt('GEMINI_TOP_K') ?? 64,
    temperature: _envFloat('GEMINI_TEMPERATURE'),
    supportsDynamicThinking: modelSupportsDynamicThinking(model),
  }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/**
 * Synthetic thought signature used when no real signature is available.
 * The Gemini API accepts this sentinel to bypass strict signature validation.
 * Matches the constant used by the Gemini CLI.
 */
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

export type GeminiPart =
  | { text: string; thought?: boolean }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { id?: string; name: string; response: { content: string } } }
  | { inlineData: { mimeType: string; data: string } }

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

// ─── Schema Sanitization ───────────────────────────────────────────

/**
 * Fields that Gemini's functionDeclarations do NOT support.
 * Gemini accepts a subset of OpenAPI 3.0 schema: type, format,
 * description, nullable, enum, items, properties, required,
 * minimum, maximum, minItems, maxItems, minLength, maxLength.
 * Everything else must be stripped recursively.
 */
const UNSUPPORTED_GEMINI_SCHEMA_FIELDS = new Set([
  // JSON Schema identifiers & references
  '$schema', '$id', '$ref', '$comment', '$defs', 'definitions',
  // Composition keywords — handled by flattenComposition() before stripping
  'not', 'if', 'then', 'else',
  // Object validation keywords Gemini rejects
  'additionalProperties', 'patternProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'unevaluatedProperties',
  'dependentRequired', 'dependentSchemas',
  // Number validation keywords beyond min/max
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  // String validation (pattern is regex — Gemini doesn't support it)
  'pattern', 'contentMediaType', 'contentEncoding',
  // Array validation beyond items/min/max
  'unevaluatedItems', 'prefixItems', 'contains', 'minContains', 'maxContains',
  // Metadata fields
  'default', 'const', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'title',
])

/**
 * Flatten JSON Schema composition keywords (anyOf, oneOf, allOf) that
 * Gemini cannot handle natively. Strategy:
 *
 *   - anyOf / oneOf with a null type → extract the non-null branch + nullable
 *   - anyOf / oneOf without null → take the first branch
 *   - allOf → shallow-merge all branches into one schema
 *
 * This runs BEFORE the normal sanitize pass so the flattened result can
 * be cleaned of unsupported fields normally.
 */
function flattenComposition(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  // Handle type arrays like ["string", "null"] → type: "string", nullable: true
  if (Array.isArray(result.type)) {
    const types = result.type as string[]
    const nonNull = types.filter(t => t !== 'null')
    if (types.includes('null')) {
      result.nullable = true
    }
    result.type = nonNull.length === 1 ? nonNull[0] : nonNull[0] ?? 'string'
  }

  // anyOf / oneOf → pick first non-null variant, set nullable if null present
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const variants = result[keyword] as Record<string, unknown>[] | undefined
    if (!Array.isArray(variants) || variants.length === 0) continue

    const nonNull = variants.filter(v => v.type !== 'null')
    const hasNull = variants.some(v => v.type === 'null')
    const picked = nonNull[0] ?? variants[0]!

    // Merge the picked variant's fields into result
    delete result[keyword]
    if (hasNull) result.nullable = true
    for (const [k, v] of Object.entries(picked)) {
      if (v !== undefined && !(k in result && k !== keyword)) {
        result[k] = v
      }
    }
  }

  // allOf → shallow-merge all branches
  if (Array.isArray(result.allOf)) {
    const branches = result.allOf as Record<string, unknown>[]
    delete result.allOf
    for (const branch of branches) {
      for (const [k, v] of Object.entries(branch)) {
        if (v === undefined) continue
        if (k === 'properties' && result.properties) {
          // Merge properties objects
          result.properties = {
            ...(result.properties as Record<string, unknown>),
            ...(v as Record<string, unknown>),
          }
        } else if (k === 'required' && result.required) {
          // Merge required arrays
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

/**
 * Recursively strip fields that Gemini does not support from a JSON Schema object.
 * Also handles composition keywords (anyOf/oneOf/allOf) by flattening them,
 * type arrays by extracting the non-null type, and empty required arrays.
 * Returns a new object — does not mutate the original.
 */
export function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  // First pass: flatten composition keywords
  const flattened = flattenComposition(schema)
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flattened)) {
    // Strip unsupported fields and undefined values
    if (UNSUPPORTED_GEMINI_SCHEMA_FIELDS.has(key)) continue
    // OpenAPI 3.0 vendor extensions (x-google-enum-descriptions, x-google-quota,
    // x-stripe-*, …) leak in from MCP tool schemas. Gemini's validator 400s on
    // unknown fields, so strip the whole x-* family.
    if (key.startsWith('x-')) continue
    if (value === undefined) continue

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into each property definition
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([propName, propSchema]) => [
            propName,
            propSchema && typeof propSchema === 'object' && !Array.isArray(propSchema)
              ? sanitizeSchemaForGemini(propSchema as Record<string, unknown>)
              : propSchema,
          ]),
      )
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into array item schema
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else if (key === 'required' && Array.isArray(value)) {
      // Gemini rejects empty required arrays — only include if non-empty.
      if (value.length > 0) {
        result[key] = value
      }
    } else if (Array.isArray(value)) {
      // Recurse into arrays of schemas (e.g. items as tuple)
      result[key] = value.map(item =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? sanitizeSchemaForGemini(item as Record<string, unknown>)
          : item,
      )
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into any nested schema object
      result[key] = sanitizeSchemaForGemini(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

// ─── Tool schema augmentation ──────────────────────────────────────

/**
 * Compact reminder prepended to systemInstruction whenever tools are present.
 * Backstops the server-side `mode: "VALIDATED"` enforcement: the API will
 * already reject calls with missing required params, but this nudges the
 * model to emit valid calls in the first place instead of triggering retries.
 *
 * Kept short (≈10 lines) because every byte here is on every Gemini turn.
 * The previous 50-line version measurably hurt latency on flash-lite.
 */
const GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION = `<TOOL_USAGE_RULES>
Tool schemas in this environment OVERRIDE your training-data memory of tool names.
Treat each tool's "parameters" field as authoritative:
- Use parameter NAMES exactly as listed in "properties" (case-sensitive).
- Supply EVERY parameter listed in "required" — never omit one, never send empty objects.
- Match parameter TYPES exactly (array means array, object means object, string means string).
- Do not invent extra parameters that are not in "properties".
The "STRICT PARAMETERS:" hint at the end of each tool description is your quick reference.
</TOOL_USAGE_RULES>
`

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
 * Builds the "STRICT PARAMETERS: ..." line that gets appended to each tool's
 * description so the model has a compact, in-context reminder of names, types
 * and required flags.
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

function appendStrictParamsToDescription(description: string | undefined, parameters: Record<string, unknown>): string {
  const summary = buildStrictParamsSummary(parameters)
  const base = (description ?? '').trim()
  if (base.includes('STRICT PARAMETERS:')) return description ?? ''
  return base.length > 0
    ? `${base}\n\nSTRICT PARAMETERS: ${summary}`
    : `STRICT PARAMETERS: ${summary}`
}

// ─── Conversion ────────────────────────────────────────────────────

export function anthropicToGeminiRequest(params: ProviderRequestParams): GeminiRequest {
  // Resolve the actual Gemini model name (params.model may already be resolved
  // by the provider, or may still be a Claude alias — handle both).
  const model = params.model

  // Per-request map: track tool_use_id → tool_name because Gemini's
  // functionResponse uses the function name, not an ID.
  const toolIdToName = new Map<string, string>()
  const request: GeminiRequest = {
    contents: convertMessages(params.messages, toolIdToName),
  }

  // System prompt → systemInstruction (strip Anthropic-specific cache_control)
  if (params.system) {
    const systemText = typeof params.system === 'string'
      ? params.system
      : (params.system as SystemBlock[]).map(s => {
          const { cache_control, ...rest } = s as SystemBlock & { cache_control?: unknown }
          return rest.text
        }).join('\n\n')
    if (systemText) {
      request.systemInstruction = { parts: [{ text: systemText }] }
    }
  }

  // Tools → functionDeclarations (sanitize schemas for Gemini compatibility)
  if (params.tools && params.tools.length > 0) {
    request.tools = [{
      functionDeclarations: params.tools.map(t => {
        const sanitizedName = sanitizeGeminiToolName(t.name)
        rememberGeminiToolRename(t.name, sanitizedName)
        const parameters = sanitizeSchemaForGemini(t.input_schema)
        // Cache under both names so the inbound side can look up by either.
        recordToolSchema(t.name, parameters)
        if (sanitizedName !== t.name) recordToolSchema(sanitizedName, parameters)
        return {
          name: sanitizedName,
          description: appendStrictParamsToDescription(t.description, parameters),
          parameters,
        }
      }),
    }]

    // Server-side schema enforcement. With mode="VALIDATED" Gemini's API
    // validates each functionCall against the declared parameters BEFORE
    // returning. Calls with missing required params are retried internally
    // instead of being surfaced to us as InputValidationError. This is the
    // primary fix for the "required parameter X is missing" failure mode.
    request.toolConfig = {
      functionCallingConfig: { mode: 'VALIDATED' },
    }

    // Backstop nudge so the model emits valid calls on the first try and
    // saves Gemini from forcing a server-side retry.
    const existingText = request.systemInstruction?.parts?.[0]?.text ?? ''
    if (!existingText.includes('<TOOL_USAGE_RULES>')) {
      const merged = existingText
        ? `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}\n${existingText}`
        : GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION
      request.systemInstruction = { parts: [{ text: merged }] }
    }
  }

  // Safety settings — derived from env or default to all-OFF.
  const safety = getGeminiSafetySettings()
  if (safety) request.safetySettings = safety

  // Generation config — dynamically derived from model capabilities
  // and overridable via env vars.
  const defaults = getModelGenerationDefaults(model)
  request.generationConfig = {
    maxOutputTokens: params.max_tokens,
    temperature: defaults.temperature ?? params.temperature ?? 1,
    topP: defaults.topP,
    topK: defaults.topK,
    ...(params.stop_sequences && { stopSequences: params.stop_sequences }),
  }

  // ─── Thinking Config ──────────────────────────────────────────────
  //
  // This is the most critical setting for both QUALITY and SPEED.
  //
  // How Claude does it: `type: 'adaptive'` — no budget. The model
  // decides per-turn. Quick tool calls → 0 thinking tokens. Complex
  // reasoning → thousands. This is why Claude iterates tools fast.
  //
  // Gemini equivalent: `thinkingBudget: -1` (dynamic mode). Same
  // concept — the model allocates thinking tokens based on task
  // complexity. A "Read file" call uses ~0 thinking, a "design this
  // architecture" call uses 10K+.
  //
  // Priority:
  //   1. GEMINI_THINKING env var → explicit override (0=off, -1=dynamic, N=fixed)
  //   2. Anthropic 'disabled' → no thinking
  //   3. Model supports dynamic thinking → use -1 (dynamic)
  //   4. Model doesn't support thinking → skip thinkingConfig
  const envThinking = _envInt('GEMINI_THINKING')

  if (envThinking !== undefined) {
    // Explicit env override — user knows what they want.
    if (envThinking !== 0) {
      request.generationConfig.thinkingConfig = {
        thinkingBudget: envThinking,
        includeThoughts: true,
      }
    }
  } else if (params.thinking?.type === 'disabled') {
    // Explicitly off — respect it.
  } else if (defaults.supportsDynamicThinking) {
    // Model supports thinking → use DYNAMIC mode (-1).
    // This mirrors Claude's adaptive thinking: the model decides
    // how much to think per turn. Fast for tool calls, deep for
    // complex reasoning. Best of both worlds.
    request.generationConfig.thinkingConfig = {
      thinkingBudget: -1,
      includeThoughts: true,
    }
  }

  return request
}

function convertMessages(
  messages: ProviderMessage[],
  toolIdToName: Map<string, string>,
): GeminiContent[] {
  const result: GeminiContent[] = []

  for (const msg of messages) {
    const geminiRole = msg.role === 'assistant' ? 'model' : 'user'

    if (typeof msg.content === 'string') {
      // Merge consecutive same-role messages (Gemini requires alternating roles)
      const last = result[result.length - 1]
      if (last && last.role === geminiRole) {
        last.parts.push({ text: msg.content })
      } else {
        result.push({ role: geminiRole, parts: [{ text: msg.content }] })
      }
      continue
    }

    const blocks = msg.content as ProviderContentBlock[]
    const parts: GeminiPart[] = []

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          if (block.text) parts.push({ text: block.text })
          break

        case 'tool_use': {
          // Track id → name for later functionResponse
          if (block.id && block.name) {
            toolIdToName.set(block.id, block.name)
          }
          // Always include thoughtSignature (camelCase) — Gemini 2.5+
          // thinking models require it on every functionCall in history.
          // Priority: real sig from content block → session cache → synthetic.
          const sig = block._gemini_thought_signature
            ?? getThoughtSignature(block.id ?? '')
            ?? SYNTHETIC_THOUGHT_SIGNATURE
          // Carry the Anthropic tool_use.id on functionCall.id. Pure Gemini
          // ignores unknown fields, but Antigravity's proxy uses this to
          // populate `tool_use.id` when it converts the request to Claude
          // format — without it, Claude rejects with "tool_use.id: Field
          // required". Matches 9router's openai-to-gemini converter.
          const fcPart: Record<string, unknown> = {
            functionCall: {
              ...(block.id ? { id: block.id } : {}),
              name: block.name ?? '',
              args: (block.input as Record<string, unknown>) ?? {},
            },
            thoughtSignature: sig,
          }
          parts.push(fcPart as GeminiPart)
          break
        }

        case 'thinking':
          // Gemini thinking text → { text, thought: true }
          if (block.thinking) {
            parts.push({ text: block.thinking, thought: true })
          }
          break

        case 'redacted_thinking':
          // Anthropic redacted thinking — not applicable to Gemini, skip
          break

        case 'tool_result': {
          // Look up the function name from the tool_use_id
          const funcName = block.tool_use_id
            ? toolIdToName.get(block.tool_use_id) ?? block.tool_use_id
            : 'unknown'
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.text ?? '').join('')
              : ''
          // Carry tool_use_id on functionResponse.id — same reason as the
          // functionCall.id above: Antigravity's proxy uses it to emit
          // `tool_result.tool_use_id` that references the matching tool_use
          // in the assistant's prior turn.
          parts.push({
            functionResponse: {
              ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
              name: funcName,
              response: { content },
            },
          } as GeminiPart)
          if (Array.isArray(block.content)) {
            for (const item of block.content) {
              if (item.type === 'image' && item.source) {
                parts.push({
                  inlineData: {
                    mimeType: item.source.media_type,
                    data: item.source.data,
                  },
                })
              }
            }
          }
          break
        }

        case 'image':
          if (block.source) {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            })
          }
          break
      }
    }

    if (parts.length === 0) continue

    // Merge consecutive same-role (Gemini constraint)
    const last = result[result.length - 1]
    if (last && last.role === geminiRole) {
      last.parts.push(...parts)
    } else {
      result.push({ role: geminiRole, parts })
    }
  }

  return result
}
