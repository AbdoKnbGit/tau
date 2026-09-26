/**
 * Optional tool arguments that a model filled in with a placeholder.
 *
 * Many models supply every parameter a tool declares and write "not set" as
 * `null`, `""`, `0`, `false`, `[]` or `{}`. Strict-mode lanes make it
 * mandatory: a strict schema lists every property as required and encodes the
 * optional ones as nullable, so the model has to send `null` for each one it
 * does not use. When such a value is one the tool's contract rejects —
 * `nth: 0` where the minimum is 1, `index: null` for a number, `pages: ""` for
 * a page range — the whole call used to fail over a parameter the model never
 * meant to set, and the model paid a round trip, or several, to learn it.
 *
 * This reads those values as what they stand for: the parameter was left out.
 * The rule is deliberately narrow:
 *
 *   - Input that already satisfies the contract is returned untouched. A
 *     placeholder the contract accepts (`offset: 0`, `run_in_background:
 *     false`) is the model's value and is kept.
 *   - Only a placeholder that one of the contract's own issues points at is
 *     dropped, and only as an object property. Array items are never removed.
 *   - The result is used only if it satisfies the whole contract. Dropping a
 *     required parameter is itself an issue, so a required placeholder is
 *     never dropped; that call fails exactly as it did before.
 *
 * The contract arrives as a judge function, so one rule serves built-in tools
 * (their Zod schema) and MCP tools (the server's JSON Schema) on every lane.
 * Nothing here depends on the platform, the provider or a tool's name.
 */

export type ArgumentPath = readonly (string | number)[]

export type ArgumentIssue = {
  readonly path: ArgumentPath
  readonly message: string
}

/**
 * Every issue a contract finds in a value: `[]` when the value is valid,
 * `null` when the contract cannot judge it (it failed to compile, say). A
 * `null` verdict is never read as "invalid".
 */
export type ArgumentJudge = (value: unknown) => readonly ArgumentIssue[] | null

export type DroppedArgument = {
  readonly path: ArgumentPath
  readonly value: unknown
  /** The contract's own complaint about the value, for the model-facing note. */
  readonly reason: string
  /** Dropped whole as a malformed advisory field, not as a placeholder. */
  readonly advisory?: boolean
}

export type ArgumentRepair = {
  readonly input: Record<string, unknown>
  readonly dropped: readonly DroppedArgument[]
}

/** Enough passes for a drop to expose the next issue; each pass drops at least one field. */
const MAX_PASSES = 4
/** Zod unions nest; bound the walk because schemas can be third-party. */
const MAX_ISSUE_DEPTH = 8
const MAX_REASON_LENGTH = 160

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The values models use to mean "not set". Zero and `false` count: a model
 * that fills every field writes an unused number as 0 and an unused flag as
 * false. They are only ever dropped when the contract rejects them.
 */
export function isPlaceholderValue(value: unknown): boolean {
  if (value === null || value === 0 || value === false) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/**
 * The narrower set used where no issue path says which field is at fault:
 * values that carry nothing at all. Zero and `false` are left out, because an
 * accepted 0 or false is often a real setting (an unlimited limit, say).
 */
export function isEmptyArgumentValue(value: unknown): boolean {
  if (value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

function childOf(node: unknown, segment: string | number): { found: boolean; value?: unknown } {
  if (Array.isArray(node)) {
    const index = typeof segment === 'number' ? segment : Number(segment)
    if (!Number.isInteger(index) || index < 0 || index >= node.length) return { found: false }
    return { found: true, value: node[index] }
  }
  if (!isPlainObject(node)) return { found: false }
  const key = String(segment)
  if (!Object.prototype.hasOwnProperty.call(node, key)) return { found: false }
  return { found: true, value: node[key] }
}

function valueAt(root: unknown, path: ArgumentPath): unknown {
  let node = root
  for (const segment of path) {
    const child = childOf(node, segment)
    if (!child.found) return undefined
    node = child.value
  }
  return node
}

/** A copy of `root` without the object property at `path`. Array items are never removed. */
function withoutPath(root: unknown, path: ArgumentPath): unknown {
  if (path.length === 0) return root
  const [head, ...rest] = path
  if (Array.isArray(root)) {
    const index = typeof head === 'number' ? head : Number(head)
    if (rest.length === 0 || !Number.isInteger(index) || index < 0 || index >= root.length) {
      return root
    }
    const copy = root.slice()
    copy[index] = withoutPath(root[index], rest)
    return copy
  }
  if (!isPlainObject(root)) return root
  const key = String(head)
  if (!Object.prototype.hasOwnProperty.call(root, key)) return root
  if (rest.length === 0) {
    const { [key]: _dropped, ...others } = root
    return others
  }
  return { ...root, [key]: withoutPath(root[key], rest) }
}

function samePath(a: ArgumentPath, b: ArgumentPath): boolean {
  return a.length === b.length && a.every((segment, index) => String(segment) === String(b[index]))
}

function isUnder(path: ArgumentPath, prefix: ArgumentPath): boolean {
  return prefix.length <= path.length &&
    prefix.every((segment, index) => String(segment) === String(path[index]))
}

/**
 * Placeholders the issues point at: for each issue, the first object property
 * along its path whose value is a placeholder. A placeholder is a leaf, so an
 * issue can only be at it or, for an empty object, about a key inside it.
 */
function placeholdersBlamed(
  input: Record<string, unknown>,
  issues: readonly ArgumentIssue[],
): ArgumentPath[] {
  const blamed: ArgumentPath[] = []
  for (const issue of issues) {
    let node: unknown = input
    for (let depth = 0; depth < issue.path.length; depth++) {
      const segment = issue.path[depth]!
      const child = childOf(node, segment)
      if (!child.found) break
      if (isPlainObject(node) && isPlaceholderValue(child.value)) {
        const path = issue.path.slice(0, depth + 1)
        if (!blamed.some(existing => samePath(existing, path))) blamed.push(path)
        break
      }
      node = child.value
    }
  }
  return blamed
}

/**
 * Advisory fields (a tool's declaration that a field never changes what the
 * call does) are dropped whole, whatever their value — but only when every
 * remaining issue lies inside them, so a call that is wrong elsewhere still
 * reports everything.
 */
function advisoryFieldsBlamed(
  input: Record<string, unknown>,
  issues: readonly ArgumentIssue[],
  advisoryFields: readonly string[],
): string[] | null {
  if (advisoryFields.length === 0 || issues.length === 0) return null
  const fields: string[] = []
  for (const issue of issues) {
    const head = issue.path[0]
    if (
      head === undefined ||
      !advisoryFields.includes(String(head)) ||
      !Object.prototype.hasOwnProperty.call(input, String(head))
    ) {
      return null
    }
    if (!fields.includes(String(head))) fields.push(String(head))
  }
  return fields
}

function reasonFor(issues: readonly ArgumentIssue[], path: ArgumentPath): string {
  const exact = issues.find(issue => samePath(issue.path, path))
  const inside = exact ?? issues.find(issue => isUnder(issue.path, path))
  const chosen = inside ?? issues[0]
  if (!chosen) return ''
  const where = chosen.path.length > path.length
    ? `${formatArgumentPath(chosen.path.slice(path.length))}: `
    : ''
  return truncate(`${where}${chosen.message}`)
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > MAX_REASON_LENGTH ? `${single.slice(0, MAX_REASON_LENGTH - 1)}…` : single
}

/**
 * Drop optional arguments whose placeholder value the contract rejects, and
 * advisory fields that are the only thing wrong with a call, when that yields
 * input the whole contract accepts. Otherwise the input comes back untouched
 * with nothing dropped, and validation reports the call as before.
 *
 * `normalize` is re-applied after each drop — MCP uses it to rerun schema
 * coercion, which cannot succeed while a placeholder still fails the object.
 */
export function dropInvalidPlaceholderArguments(
  input: Record<string, unknown>,
  judge: ArgumentJudge,
  options: {
    advisoryFields?: readonly string[]
    normalize?: (value: Record<string, unknown>) => Record<string, unknown>
  } = {},
): ArgumentRepair {
  const unchanged: ArgumentRepair = { input, dropped: [] }
  if (!isPlainObject(input)) return unchanged
  let issues = judge(input)
  if (!issues || issues.length === 0) return unchanged

  const advisoryFields = options.advisoryFields ?? []
  let current = input
  let dropped: DroppedArgument[] = []
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const advisory = advisoryFieldsBlamed(current, issues, advisoryFields)
    const removals = advisory
      ? advisory.map(field => ({ path: [field] as ArgumentPath, advisory: true }))
      : placeholdersBlamed(current, issues).map(path => ({ path, advisory: false }))
    if (removals.length === 0) return unchanged

    for (const removal of removals) {
      // A field dropped whole supersedes anything dropped inside it earlier.
      dropped = dropped.filter(entry => !isUnder(entry.path, removal.path))
      dropped.push({
        path: removal.path,
        value: valueAt(current, removal.path),
        reason: reasonFor(issues, removal.path),
        ...(removal.advisory && { advisory: true }),
      })
      const next = withoutPath(current, removal.path)
      current = isPlainObject(next) ? next : current
    }
    if (options.normalize) current = options.normalize(current)

    issues = judge(current)
    if (issues === null) return unchanged
    if (issues.length === 0) return { input: current, dropped }
  }
  return unchanged
}

/**
 * For a tool's own validation, which reports no paths: the top-level optional
 * arguments that are empty. The caller decides whether dropping them is
 * justified, by asking the tool again.
 */
export function dropEmptyOptionalArguments(
  input: Record<string, unknown>,
  requiredFields: ReadonlySet<string>,
): ArgumentRepair {
  if (!isPlainObject(input)) return { input, dropped: [] }
  const dropped: DroppedArgument[] = []
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!requiredFields.has(key) && isEmptyArgumentValue(value)) {
      dropped.push({ path: [key], value, reason: '' })
    } else {
      kept[key] = value
    }
  }
  return dropped.length > 0 ? { input: kept, dropped } : { input, dropped: [] }
}

type ZodLikeIssue = {
  code?: unknown
  path?: unknown
  message?: unknown
  errors?: unknown
  keys?: unknown
}

function flattenZodIssues(
  issues: readonly ZodLikeIssue[],
  prefix: ArgumentPath,
  out: ArgumentIssue[],
  depth: number,
): void {
  for (const issue of issues) {
    const own = Array.isArray(issue.path)
      ? issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        )
      : []
    const path = [...prefix, ...own]
    const message = typeof issue.message === 'string' ? issue.message : 'Invalid input'
    if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
      for (const key of issue.keys) {
        if (typeof key === 'string') out.push({ path: [...path, key], message })
      }
      continue
    }
    out.push({ path, message })
    // A union reports its branches' issues relative to itself. Following them
    // is what lets a placeholder nested inside a union be seen at all.
    if (issue.code === 'invalid_union' && Array.isArray(issue.errors) && depth < MAX_ISSUE_DEPTH) {
      for (const branch of issue.errors) {
        if (Array.isArray(branch)) flattenZodIssues(branch as ZodLikeIssue[], path, out, depth + 1)
      }
    }
  }
}

/** Judge by a Zod schema (anything with Zod's `safeParse` result shape). */
export function zodArgumentJudge(schema: {
  safeParse(value: unknown): { success: boolean; error?: { issues?: unknown } }
}): ArgumentJudge {
  return value => {
    let result: { success: boolean; error?: { issues?: unknown } }
    try {
      result = schema.safeParse(value)
    } catch {
      return null
    }
    if (result.success) return []
    const issues = result.error?.issues
    if (!Array.isArray(issues)) return null
    const out: ArgumentIssue[] = []
    flattenZodIssues(issues as ZodLikeIssue[], [], out, 0)
    return out
  }
}

export function formatArgumentPath(path: ArgumentPath): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number' || /^\d+$/.test(segment)) out += `[${segment}]`
    else out += out ? `.${segment}` : segment
  }
  return out
}

function renderPlaceholder(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const PLACEHOLDER_ADVICE =
  'Leave out optional parameters you are not using instead of filling them with placeholders such as null, "", 0, false, [] or {}.'

/**
 * The note appended to the tool result so the model knows what did not reach
 * the tool. `null` drops are silent: null is how strict-mode lanes write an
 * omitted parameter, so treating it as omitted is the protocol, not a mistake.
 * Deterministic for a given call, so a replayed transcript is byte-stable.
 */
export function describeDroppedArguments(dropped: readonly DroppedArgument[]): string | undefined {
  const shown = dropped.filter(entry => entry.advisory || entry.value !== null)
  if (shown.length === 0) return undefined
  const items = shown.map(entry => {
    const name = `\`${formatArgumentPath(entry.path)}\``
    const value = entry.advisory ? '' : ` = ${renderPlaceholder(entry.value)}`
    return entry.reason ? `${name}${value} (${entry.reason})` : `${name}${value}`
  })
  const plural = shown.length > 1
  const advice = shown.some(entry => !entry.advisory) ? ` ${PLACEHOLDER_ADVICE}` : ''
  return `Ignored optional argument${plural ? 's' : ''} that the tool's schema rejects: ${items.join('; ')}. The call ran without ${plural ? 'them' : 'it'}.${advice}`
}

/** The note for empty arguments the tool's own validation refused. */
export function describeRefusedEmptyArguments(
  dropped: readonly DroppedArgument[],
  refusal: string,
): string | undefined {
  const shown = dropped.filter(entry => entry.value !== null)
  if (shown.length === 0) return undefined
  const plural = shown.length > 1
  const items = shown
    .map(entry => `\`${formatArgumentPath(entry.path)}\` = ${renderPlaceholder(entry.value)}`)
    .join(', ')
  return `Ignored empty optional argument${plural ? 's' : ''} ${items}: the tool refused the call with ${plural ? 'them' : 'it'} (${truncate(refusal)}) and accepted it without. ${PLACEHOLDER_ADVICE}`
}
