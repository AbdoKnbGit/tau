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
import Ajv2019 from 'ajv/dist/2019.js'
import Ajv2020 from 'ajv/dist/2020.js'
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
  | 'decode_error'

/**
 * Which JSON Schema dialect a contract is written in.
 *
 * This used to delete `$schema` and validate everything with Ajv's default,
 * which is Draft-07. That silently reinterprets a newer contract: a 2020-12
 * schema's `dependentRequired` was not a keyword Draft-07 knows, so Ajv
 * ignored it and arguments the server would reject passed validation. The
 * dialect is read rather than discarded.
 *
 * MCP's own schemas are 2020-12, and a server that states no dialect is far
 * more likely to be writing 2020-12 than Draft-07, so that is the default for
 * an unstated dialect.
 */
type SchemaDialect = 'draft2020' | 'draft2019' | 'draft07'

function dialectOf(schema: Record<string, unknown>): {
  dialect: SchemaDialect
  /** True when `$schema` names something no shipped dialect recognizes. */
  unrecognized: boolean
} {
  const declared = schema.$schema
  if (typeof declared !== 'string') {
    return { dialect: 'draft2020', unrecognized: false }
  }
  if (declared.includes('2020-12')) {
    return { dialect: 'draft2020', unrecognized: false }
  }
  if (declared.includes('2019-09')) {
    return { dialect: 'draft2019', unrecognized: false }
  }
  if (declared.includes('draft-07') || declared.includes('draft-06')) {
    return { dialect: 'draft07', unrecognized: false }
  }
  // A dialect URI no shipped meta-schema matches. Ajv cannot resolve it, so
  // compiling with it would fail and make the tool uncallable. The structural
  // keywords are shared across dialects, so validate under the newest — but
  // say the dialect was unrecognized, so the caller drops it rather than
  // handing Ajv a meta-schema it will reject.
  return { dialect: 'draft2020', unrecognized: true }
}

const ajvByDialect = new Map<SchemaDialect, Ajv>()

function getAjv(dialect: SchemaDialect = 'draft2020'): Ajv {
  const existing = ajvByDialect.get(dialect)
  if (existing) return existing
  // Schemas come from third-party MCP servers and from Zod v4's 2020-12
  // output. Neither is worth failing a call over, so stay permissive about
  // strict-mode metadata and formats and let the structural keywords do the
  // work — but under the right dialect, so newer keywords are enforced.
  const options = { allErrors: true, strict: false, validateFormats: false }
  const created =
    dialect === 'draft07'
      ? new Ajv(options)
      : dialect === 'draft2019'
        ? (new Ajv2019(options) as unknown as Ajv)
        : (new Ajv2020(options) as unknown as Ajv)
  ajvByDialect.set(dialect, created)
  return created
}

/** Compiled validators, keyed by contract hash rather than by tool name. */
const validators = new Map<string, ValidateFunction | null>()
const MAX_CACHED_VALIDATORS = 500

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

  const { dialect, unrecognized } = dialectOf(schema)
  // Keep `$schema` for a dialect Ajv ships, so the instance and the contract
  // agree. Drop only an unresolvable one, which Ajv would refuse outright.
  const compilable = unrecognized
    ? (() => {
        const { $schema: _unknownDialect, ...rest } = schema
        return rest
      })()
    : schema
  let compiled: ValidateFunction | null = null
  try {
    // Compile in an isolated Ajv so two contracts may share an `$id`.
    //
    // A shared instance registers each compiled schema under its `$id`, so a
    // server that updated its schema — or a second server that happened to
    // reuse the same `$id` — hit "schema with key or id already exists" and
    // its contract was reported unsupported. The tool then could not be
    // called at all. Compilation is cheap next to a round-trip to the server,
    // and the compiled validator is still cached by contract hash.
    //
    // `$schema` is kept: dialectOf read it, and Ajv needs it to agree with
    // the instance it is compiled by.
    compiled = createIsolatedAjv(dialect).compile(compilable)
  } catch {
    compiled = null
  }

  if (validators.size >= MAX_CACHED_VALIDATORS) {
    // Bounded: schemas change, agents come and go, and a validator per
    // contract seen in a long session would otherwise grow without limit.
    // Deleting the entry also drops the only reference to its isolated Ajv,
    // so the compiled state it retains is released with it.
    const oldest = validators.keys().next()
    if (!oldest.done) validators.delete(oldest.value)
  }
  validators.set(key, compiled)
  return compiled
}

function createIsolatedAjv(dialect: SchemaDialect): Ajv {
  const options = { allErrors: true, strict: false, validateFormats: false }
  if (dialect === 'draft07') return new Ajv(options)
  if (dialect === 'draft2019') return new Ajv2019(options) as unknown as Ajv
  return new Ajv2020(options) as unknown as Ajv
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
/**
 * Pure structural check against a contract: does this value satisfy it?
 *
 * No mutation, no defaults, no coercion — the repair engine needs to ask
 * "was this already valid?" before it proposes anything, and needs an
 * unbiased verdict on each candidate it proposes.
 *
 * Returns `null` when the contract could not be compiled, which is different
 * from "invalid": the caller must not treat an uncompilable contract as a
 * failed value.
 */
export function isValidAgainstContract(
  schema: Record<string, unknown>,
  value: unknown,
): boolean | null {
  const validate = getValidator(schema)
  if (!validate) return null
  return validate(value) === true
}

/**
 * The JSON-pointer paths of every validation error for this value.
 *
 * Lets the repair engine ask whether a proposal improved the one field it
 * touches, which is the only question it can answer when several fields are
 * wrong at once and no single change makes the whole object valid.
 *
 * Returns `null` when the contract could not be compiled.
 */
export function contractErrors(
  schema: Record<string, unknown>,
  value: unknown,
): string[] | null {
  const validate = getValidator(schema)
  if (!validate) return null
  if (validate(value) === true) return []
  return (validate.errors ?? []).map(error => error.instancePath)
}

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
    const details = getAjv(dialectOf(schema).dialect).errorsText(validate.errors, {
      dataVar: tool.name,
    })
    const note = describeUnparseableJsonArguments(record, validate.errors)
    return fail(
      'invalid_arguments',
      schema,
      `${tool.name} arguments are invalid: ${details}.${note}`,
    )
  }

  return { ok: true }
}

/**
 * Explain a string that was clearly meant to be a structure.
 *
 * Arguments are repaired toward the schema before they get here (see
 * coerceMcpInput), so a string still sitting where an array or object belongs
 * is one whose JSON did not parse. "must be array" alone leaves the model to
 * guess whether it picked the wrong field, the wrong type, or simply mangled
 * its escaping — the parser's own complaint says which, and is the one piece
 * of information that lets it fix the call in one attempt.
 */
/**
 * The character offset a JSON parse error reports, if it states one.
 *
 * Extracted rather than passing the message through, so nothing but a number
 * can reach a model-facing string or telemetry.
 */
function parsePositionOf(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined
  const match = /position (\d+)/.exec(error.message)
  if (!match) return undefined
  const position = Number(match[1])
  return Number.isFinite(position) ? position : undefined
}

function describeUnparseableJsonArguments(
  record: Record<string, unknown>,
  errors: ValidateFunction['errors'],
): string {
  if (!errors) return ''
  const notes: string[] = []
  const seen = new Set<string>()

  for (const error of errors) {
    if (error.keyword !== 'type') continue
    const expected = (error.params as { type?: unknown }).type
    const wants =
      typeof expected === 'string'
        ? [expected]
        : Array.isArray(expected)
          ? expected.filter((t): t is string => typeof t === 'string')
          : []
    if (!wants.includes('array') && !wants.includes('object')) continue

    // instancePath is a JSON pointer like `/batch`; only top-level arguments
    // are reported, which is where a stringified payload actually lands.
    const field = error.instancePath.replace(/^\//, '')
    if (!field || field.includes('/') || seen.has(field)) continue
    const value = record[field]
    if (typeof value !== 'string') continue

    const trimmed = value.trim()
    const first = trimmed[0]
    const looksJson = first === '[' || first === '{'
    if (!looksJson) continue

    seen.add(field)
    try {
      JSON.parse(trimmed)
      // It parses, so coercion would have taken it; the shape must be wrong.
      notes.push(
        `\`${field}\` was sent as a JSON string whose parsed value is still not a ${wants.join(' or ')}.`,
      )
    } catch (parseError) {
      // Report only the position, never the parser's raw message. V8's text
      // happens to be positional today, but that is an implementation
      // detail, and this string is also copied into analytics errorDetails
      // — a parser that quoted the offending fragment would put argument
      // content into telemetry.
      const position = parsePositionOf(parseError)
      notes.push(
        `\`${field}\` was sent as a JSON string, but it is not valid JSON` +
          (position === undefined ? '' : ` (first error at position ${position})`) +
          `. Send it as a real ${wants.join(' or ')} value rather than a quoted string.`,
      )
    }
  }

  return notes.length > 0 ? `\n${notes.join('\n')}` : ''
}
