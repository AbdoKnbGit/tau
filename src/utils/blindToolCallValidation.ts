import { Ajv, type ValidateFunction } from 'ajv'
import type { Tool } from '../Tool.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * A "blind" call is a tool_use produced by a request that did not carry the
 * tool's parameter schema. Blocking those calls outright cost a full turn and
 * surfaced an internal recovery error, so instead they are checked against the
 * schema Tau already holds locally: a call that matches the real schema is
 * indistinguishable from an informed one and runs immediately, while a call
 * carrying invented parameters is rejected the same way any malformed call is.
 *
 * Only the checks the normal validation path cannot make are done here.
 * Required fields and value types are already enforced by the tool's Zod
 * schema; what Zod deliberately does NOT do is reject unknown properties
 * (`.strip()` silently drops them, which is how a guessed parameter would
 * become a silent behavior change). MCP tools carry a JSON Schema instead of a
 * usable Zod schema, so they are validated with Ajv here or not at all.
 */
export type BlindCallCheck = { ok: true } | { ok: false; message: string }

let ajvInstance: Ajv | null = null
const validatorCache = new Map<string, ValidateFunction | null>()

function getAjv(): Ajv {
  if (!ajvInstance) {
    // Tool schemas come from third-party MCP servers and from Zod v4's
    // 2020-12 output. Neither is worth failing a call over, so keep Ajv
    // permissive about dialect/format metadata and let the structural
    // keywords (type/required/properties/enum) do the work.
    ajvInstance = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    })
  }
  return ajvInstance
}

function getDeclaredSchema(tool: Tool): Record<string, unknown> | null {
  if (tool.inputJSONSchema) {
    return tool.inputJSONSchema as unknown as Record<string, unknown>
  }
  try {
    return zodToJsonSchema(tool.inputSchema) as Record<string, unknown>
  } catch {
    return null
  }
}

function getValidator(tool: Tool, schema: Record<string, unknown>) {
  const cached = validatorCache.get(tool.name)
  if (cached !== undefined) return cached
  let compiled: ValidateFunction | null = null
  try {
    // `$schema` names a dialect Ajv 8 does not ship by default; the structural
    // keywords are dialect-independent, so drop it rather than refuse.
    const { $schema: _dialect, ...rest } = schema
    compiled = getAjv().compile(rest)
  } catch {
    compiled = null
  }
  validatorCache.set(tool.name, compiled)
  return compiled
}

/** Exported for tests: schema compilation is cached per tool name. */
export function resetBlindCallValidatorCache(): void {
  validatorCache.clear()
  ajvInstance = null
}

function summarizeJsonSchema(schema: Record<string, unknown>): string | null {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return null
  try {
    const summary: Record<string, unknown> = { type: 'object', properties }
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      summary.required = schema.required
    }
    const text = JSON.stringify(summary, null, 2)
    return text.length > 1500 ? `${text.slice(0, 1500)}\n… (truncated)` : text
  } catch {
    return null
  }
}

function withSchema(
  schema: Record<string, unknown>,
  message: string,
): BlindCallCheck {
  const summary = summarizeJsonSchema(schema)
  return {
    ok: false,
    message: summary ? `${message}\nExpected input schema:\n${summary}` : message,
  }
}

/**
 * Decide whether a blind deferred call may run as sent.
 *
 * `input` must already be coerced by `coerceToolInput`, so near-miss key
 * spellings and stringified scalars are treated exactly as the normal
 * execution path would treat them.
 */
export function checkBlindDeferredCallInput(
  tool: Tool,
  input: unknown,
): BlindCallCheck {
  const schema = getDeclaredSchema(tool)
  if (!schema) {
    // No local schema to check against. Non-MCP tools still go through Zod
    // next, so let them proceed; an MCP call cannot be verified at all.
    return tool.isMcp
      ? {
          ok: false,
          message:
            `${tool.name}'s schema was not declared on the request that produced this call and could not be verified locally, ` +
            `so it was not run.`,
        }
      : { ok: true }
  }

  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : null

  if (properties) {
    const invented = Object.keys(record).filter(key => !(key in properties))
    if (invented.length > 0) {
      return withSchema(
        schema,
        `${tool.name} was called with ${invented.length === 1 ? 'a parameter' : 'parameters'} that its schema does not define: ` +
          `${invented.map(key => `\`${key}\``).join(', ')}. ` +
          `This call was produced before ${tool.name}'s schema was declared, so unrecognized parameters are rejected instead of ignored. ` +
          `Re-send the call using only the fields below.`,
      )
    }
  } else if (tool.isMcp && Object.keys(record).length > 0) {
    return withSchema(
      schema,
      `${tool.name} declares no input properties, so the arguments sent with this call could not be verified and it was not run.`,
    )
  }

  // Zod already enforces required/type for built-in tools on the next step.
  // MCP tools have only a placeholder Zod schema, so validate them here.
  if (tool.isMcp) {
    const validate = getValidator(tool, schema)
    if (!validate) {
      return withSchema(
        schema,
        `${tool.name}'s schema could not be compiled for local verification, so this call was not run.`,
      )
    }
    if (!validate(record)) {
      const details = getAjv().errorsText(validate.errors, {
        dataVar: tool.name,
      })
      return withSchema(schema, `${tool.name} arguments are invalid: ${details}.`)
    }
  }

  return { ok: true }
}
