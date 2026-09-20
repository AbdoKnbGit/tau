/**
 * Repair MCP tool arguments toward the server's own JSON Schema.
 *
 * `coerceToolInput` recovers the common model mistakes — a stringified array,
 * a numeric string, a near-miss key spelling — but it reads the expected types
 * off the tool's **Zod** schema. Every MCP tool shares `MCPTool`'s placeholder
 * `z.object({}).passthrough()`, which declares no properties, so that pass
 * does nothing at all for MCP. The real types are in `inputJSONSchema`.
 *
 * Without this, a model emitting `{"batch": "[{...}]"` — a JSON string where
 * an array belongs — was repaired on the Cline lane, which grew its own copy
 * of the logic, and on no other lane.
 *
 * The governing rule is that **an already valid argument object is returned
 * untouched**. An earlier version of this walked each node independently and
 * repaired whatever looked mistyped, which rewrote valid input: given
 * `anyOf: [{n: integer}, {n: string}]`, a perfectly valid `{n: "5"}` became
 * `{n: 5}` and the server performed a different operation. Successful
 * validation after a mutation does not show the mutation preserved intent.
 *
 * So repair is proposal-based, not walk-based:
 *
 *   1. Validate the untouched input. If it passes, return it unchanged.
 *   2. Otherwise enumerate bounded, lossless candidate rewrites.
 *   3. Validate each candidate against the complete original contract.
 *   4. Accept only when exactly one distinct valid result emerges.
 *   5. Otherwise return the input unchanged and let validation explain it.
 *
 * Step 4 is what makes ambiguity safe: when two candidates both validate to
 * different values, there is no way to know which the model meant, so nothing
 * is guessed. Step 3 uses the whole contract, so composition, `$ref`,
 * `patternProperties` and sibling constraints are all honoured by
 * construction rather than reimplemented here.
 */

import {
  contractErrors,
  isValidAgainstContract,
} from './contractValidation.js'

/** Bounds: schemas and inputs are third-party. */
const MAX_CANDIDATES = 64
const MAX_REWRITE_DEPTH = 8
/** A JSON text longer than this is not speculatively parsed. */
const MAX_PARSE_LENGTH = 1_000_000

type Schema = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a string that looks like JSON, losslessly.
 *
 * `JSON.parse` silently rounds an integer literal too large for a double:
 * `9007199254740993` becomes `9007199254740992`, and the rounded value then
 * validates, so a corrupted identifier reaches the server looking correct.
 * Any numeric literal that does not survive a round trip disqualifies the
 * whole parse, and the original string is kept instead.
 */
function parseJsonLossless(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.length > MAX_PARSE_LENGTH) return undefined
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === '[' && last === ']') || (first === '{' && last === '}'))) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  return numbersSurviveRoundTrip(trimmed) ? parsed : undefined
}

/**
 * Does every numeric literal in this JSON text survive being parsed?
 *
 * Scanned token-aware rather than by regex over the whole text, so digits
 * inside a quoted string — an opaque id like `"9007199254740993"` — are never
 * examined, and an escaped quote does not end a string early.
 */
function numbersSurviveRoundTrip(text: string): boolean {
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '"') {
      index++
      while (index < text.length) {
        const inner = text[index]!
        if (inner === '\\') {
          index += 2
          continue
        }
        index++
        if (inner === '"') break
      }
      continue
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index
      index++
      while (index < text.length && /[0-9eE+.\-]/.test(text[index]!)) index++
      if (!numericLiteralIsExact(text.slice(start, index))) return false
      continue
    }
    index++
  }
  return true
}

/** Is this numeric literal representable as a double without changing it? */
function numericLiteralIsExact(literal: string): boolean {
  const value = Number(literal)
  if (!Number.isFinite(value)) return false
  // An integer literal must round-trip digit for digit. Comparing against
  // Number.MAX_SAFE_INTEGER alone would accept a rounded value that happens
  // to land on a representable neighbour.
  if (/^-?\d+$/.test(literal)) {
    return BigInt(literal) === BigInt(Math.trunc(value))
  }
  // A decimal is approximate by nature; reject only when its normalized
  // value actually differs, so ordinary decimals are not refused.
  return Number(String(value)) === value
}

/** Convert a numeric string exactly, or return undefined. */
function exactNumberFromString(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
    return undefined
  }
  return numericLiteralIsExact(trimmed) ? Number(trimmed) : undefined
}

/** Replace the value at `path` within `root`, returning a new structure. */
function replaceAt(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (typeof head === 'number') {
    if (!Array.isArray(root)) return root
    const copy = root.slice()
    copy[head] = replaceAt(root[head], rest, value)
    return copy
  }
  if (!isPlainObject(root)) return root
  return { ...root, [head as string]: replaceAt(root[head as string], rest, value) }
}

type Rewrite = { path: (string | number)[]; value: unknown }

/**
 * Every lossless rewrite of a single scalar anywhere in the input.
 *
 * Deliberately schema-blind: which rewrite is *permitted* is decided by
 * validating the candidate against the whole contract, not by this function
 * guessing at the contract's intent. That is what keeps composition,
 * `$ref` and `patternProperties` correct without reimplementing them.
 */
function collectRewrites(
  value: unknown,
  path: (string | number)[],
  depth: number,
  out: Rewrite[],
): void {
  if (out.length >= MAX_CANDIDATES || depth > MAX_REWRITE_DEPTH) return

  if (typeof value === 'string') {
    const parsed = parseJsonLossless(value)
    if (parsed !== undefined) out.push({ path, value: parsed })

    const numeric = exactNumberFromString(value)
    if (numeric !== undefined) out.push({ path, value: numeric })

    const lower = value.trim().toLowerCase()
    if (lower === 'true') out.push({ path, value: true })
    if (lower === 'false') out.push({ path, value: false })
    if (lower === 'null') out.push({ path, value: null })
    return
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push({ path, value: String(value) })
    return
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectRewrites(item, [...path, index], depth + 1, out)
    }
    return
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectRewrites(child, [...path, key], depth + 1, out)
    }
  }
}

/**
 * Repair an MCP tool's arguments toward its server-declared schema.
 *
 * Returns the input unchanged when it is already valid, when no candidate is
 * valid, when more than one distinct valid candidate exists, or when the
 * contract cannot be compiled.
 */
export function coerceMcpInput(
  input: unknown,
  inputJSONSchema: unknown,
): unknown {
  if (!isPlainObject(inputJSONSchema)) return input
  if (!isPlainObject(input)) return input
  const schema = inputJSONSchema as Schema

  // Already valid, or the contract cannot be judged: change nothing.
  const valid = isValidAgainstContract(schema, input)
  if (valid !== false) return input

  const rewrites: Rewrite[] = []
  collectRewrites(input, [], 0, rewrites)
  if (rewrites.length === 0) return input

  // Single-field repairs first: the overwhelmingly common case is one
  // stringified argument, and a single change is the least invasive fix.
  const accepted: unknown[] = []
  const seen = new Set<string>()
  for (const rewrite of rewrites) {
    const candidate = replaceAt(input, rewrite.path, rewrite.value)
    if (isValidAgainstContract(schema, candidate) !== true) continue
    const fingerprint = JSON.stringify(candidate) ?? ''
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    accepted.push(candidate)
    // Two distinct valid repairs means the intent is ambiguous. Choosing by
    // schema or traversal order would be a guess, so decline and let the
    // model see the contract.
    if (accepted.length > 1) return input
  }
  if (accepted.length === 1) return accepted[0]

  // No single change worked. A model that stringifies one argument usually
  // stringifies several, so try repairing every path at once.
  //
  // Each path is settled independently and greedily: keep a rewrite only if
  // it does not make that field worse, and leave the field alone when none
  // of its proposals fits. That avoids a combinatorial search while still
  // letting each field take the proposal that suits its own declared type —
  // a numeric string next to a string field that merely looks numeric.
  const byPath = new Map<string, Rewrite[]>()
  for (const rewrite of rewrites) {
    const key = JSON.stringify(rewrite.path)
    const existing = byPath.get(key)
    if (existing) existing.push(rewrite)
    else byPath.set(key, [rewrite])
  }
  if (byPath.size < 2) return input

  let combined: unknown = input
  for (const proposals of byPath.values()) {
    const before = fieldErrorCount(schema, combined, proposals[0]!.path)
    // Nothing wrong with this field as sent: keep the model's value.
    if (before === 0) continue
    for (const proposal of proposals) {
      const next = replaceAt(combined, proposal.path, proposal.value)
      if (fieldErrorCount(schema, next, proposal.path) < before) {
        combined = next
        break
      }
    }
  }
  return isValidAgainstContract(schema, combined) === true ? combined : input
}

/**
 * How many validation errors point at this path.
 *
 * Used to tell whether a proposal improved the field it touches, rather than
 * whether it made the whole object valid — with several broken fields, no
 * single change does the latter.
 */
function fieldErrorCount(
  schema: Schema,
  value: unknown,
  path: (string | number)[],
): number {
  const pointer = `/${path.map(String).join('/')}`
  const errors = contractErrors(schema, value)
  if (errors === null) return Number.POSITIVE_INFINITY
  return errors.filter(error => error.startsWith(pointer)).length
}
