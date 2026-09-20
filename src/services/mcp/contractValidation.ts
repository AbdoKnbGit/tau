/**
 * Validate MCP tool arguments against the server's own input schema.
 *
 * An MCP tool carries a JSON Schema from its server. Tau's `MCPTool` stands in
 * for all of them with `z.object({}).passthrough()`, which accepts anything —
 * so until now the only MCP call that was ever checked against a real schema
 * was a blind deferred one. Every other MCP call was dispatched with whatever
 * the model sent, and a mistake surfaced only as whatever the server did with
 * it. This validates them all.
 *
 * Two things the previous blind-call validator got wrong, both reproduced:
 *
 * - It cached compiled validators by tool name. A server that changed a
 *   parameter's type kept the old validator under the same name, so the new
 *   contract's valid arguments were rejected and the old contract's invalid
 *   ones accepted. Validators are keyed by a hash of the schema itself here,
 *   so a changed contract is simply a different key.
 *
 * - It rejected any property the schema's `properties` map did not name, even
 *   when the schema said `additionalProperties: true` — a schema that is open
 *   by design, whose valid extra fields it turned away. A schema that says so
 *   explicitly is now taken at its word. The extra-property rule survives only
 *   for a blind call against a schema that does not say, where an unnamed
 *   property is more likely an invention than a deliberate extra and is worth
 *   a correction round-trip rather than a silent dispatch.
 */

import { Ajv, type ValidateFunction } from 'ajv'
import { createHash } from 'crypto'
import type { Tool } from '../../Tool.js'
import { jsonStringify } from '../../utils/slowOperations.js'

export type McpArgumentCheck =
  | { ok: true }
  | { ok: false; message: string; reason: McpArgumentFailure }

export type McpArgumentFailure =
  | 'invalid_arguments'
  | 'unsupported_contract'
  | 'schema_not_exposed'

let ajvInstance: Ajv | null = null
/** Compiled validators, keyed by contract hash rather than by tool name. */
const validators = new Map<string, ValidateFunction | null>()
const MAX_CACHED_VALIDATORS = 500

function getAjv(): Ajv {
  if (!ajvInstance) {
    // Schemas come from third-party MCP servers and from Zod v4's 2020-12
    // output. Neither is worth failing a call over, so stay permissive about
    // dialect and format metadata and let the structural keywords
    // (type/required/properties/enum/additionalProperties) do the work.
    ajvInstance = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    })
  }
  return ajvInstance
}

/**
 * Stable identity for one input contract.
 *
 * Serialization is key-order sensitive, which is correct here: two schemas
 * that differ only in key order compile to the same behavior, so the worst a
 * reordering costs is one recompilation, while treating them as equal would
 * risk collapsing genuinely different contracts.
 */
export function inputContractHash(schema: Record<string, unknown>): string {
  return createHash('sha256').update(jsonStringify(schema)).digest('hex')
}

function getValidator(
  schema: Record<string, unknown>,
): ValidateFunction | null {
  const key = inputContractHash(schema)
  const cached = validators.get(key)
  if (cached !== undefined) return cached

  let compiled: ValidateFunction | null = null
  try {
    // `$schema` may name a dialect Ajv 8 does not ship. The structural
    // keywords are dialect-independent, so drop it rather than refuse to
    // validate the contract at all.
    const { $schema: _dialect, ...rest } = schema
    compiled = getAjv().compile(rest)
  } catch {
    compiled = null
  }

  if (validators.size >= MAX_CACHED_VALIDATORS) {
    // Bounded: schemas change, agents come and go, and a validator per
    // contract seen in a long session would otherwise grow without limit.
    const oldest = validators.keys().next()
    if (!oldest.done) validators.delete(oldest.value)
  }
  validators.set(key, compiled)
  return compiled
}

function summarizeSchema(schema: Record<string, unknown>): string | null {
  const properties = schema.properties
  if (!properties || typeof properties !== 'object') return null
  try {
    const summary: Record<string, unknown> = { type: 'object', properties }
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      summary.required = schema.required
    }
    if (schema.additionalProperties !== undefined) {
      summary.additionalProperties = schema.additionalProperties
    }
    const text = JSON.stringify(summary, null, 2)
    return text.length > 1500 ? `${text.slice(0, 1500)}\n… (truncated)` : text
  } catch {
    return null
  }
}

function fail(
  reason: McpArgumentFailure,
  schema: Record<string, unknown>,
  message: string,
): McpArgumentCheck {
  const summary = summarizeSchema(schema)
  return {
    ok: false,
    reason,
    message: summary
      ? `${message}\nExpected input schema:\n${summary}`
      : message,
  }
}

/**
 * Does this schema deliberately accept properties it does not name?
 *
 * Only an explicit statement counts. `additionalProperties: true` and a
 * subschema both say extras are expected — the schema is open by design, and
 * rejecting a valid extra field there was the bug. An *absent*
 * `additionalProperties` says nothing; JSON Schema's default is permissive,
 * but most MCP servers simply omit the keyword rather than meaning it, so for
 * a blind call, where the model never saw the schema, an unnamed property
 * there is still treated as a likely invention worth a correction.
 */
function isDeliberatelyOpen(schema: Record<string, unknown>): boolean {
  const additional = schema.additionalProperties
  if (additional === undefined || additional === false) return false
  return true
}

/**
 * Check one MCP call's arguments against the server's schema.
 *
 * `blind` marks a call produced by a request that never carried this tool's
 * schema. Such a call gets the extra unnamed-property check described above.
 */
export function checkMcpArguments(
  tool: Tool,
  input: unknown,
  options: { blind?: boolean } = {},
): McpArgumentCheck {
  const schema = tool.inputJSONSchema as
    | Record<string, unknown>
    | undefined
    | null

  if (!schema || typeof schema !== 'object') {
    // No contract to check against. A blind call cannot be verified at all,
    // so it does not run; an informed one was declared to the model from the
    // same missing schema, so there is nothing more to enforce here.
    return options.blind
      ? {
          ok: false,
          reason: 'schema_not_exposed',
          message:
            `${tool.name}'s schema was not declared on the request that produced this call, ` +
            `and Tau holds no local copy to verify it against, so it was not run.`,
        }
      : { ok: true }
  }

  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  if (options.blind && !isDeliberatelyOpen(schema)) {
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, unknown>)
        : {}
    const invented = Object.keys(record).filter(key => !(key in properties))
    if (invented.length > 0) {
      return fail(
        'invalid_arguments',
        schema,
        `${tool.name} was called with ${invented.length === 1 ? 'a parameter' : 'parameters'} its schema does not define: ` +
          `${invented.map(key => `\`${key}\``).join(', ')}. ` +
          `This call was produced before ${tool.name}'s schema was declared, so unrecognized parameters are rejected rather than ignored. ` +
          `Re-send the call using only the fields below.`,
      )
    }
  }

  const validate = getValidator(schema)
  if (!validate) {
    // The contract could not be compiled. Saying so is more useful than
    // either silently dispatching or claiming the arguments were wrong.
    return fail(
      'unsupported_contract',
      schema,
      `${tool.name}'s input schema could not be compiled, so its arguments could not be checked and the call was not run.`,
    )
  }

  if (!validate(record)) {
    const details = getAjv().errorsText(validate.errors, {
      dataVar: tool.name,
    })
    return fail(
      'invalid_arguments',
      schema,
      `${tool.name} arguments are invalid: ${details}.`,
    )
  }

  return { ok: true }
}
