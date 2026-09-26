type KiloAskUserOption = {
  label: string
  description: string
}

type KiloAskUserQuestion = {
  question: string
  header: string
  options: KiloAskUserOption[]
  multiSelect: boolean
}

export function kiloToolCallKey(choiceIndex: number, toolIndex: number): string {
  return `${choiceIndex}:${toolIndex}`
}

export function parseKiloToolCallKey(key: string): { choiceIndex: number; toolIndex: number } | null {
  const [choice, tool] = key.split(':', 2)
  const choiceIndex = Number(choice)
  const toolIndex = Number(tool)
  if (!Number.isInteger(choiceIndex) || !Number.isInteger(toolIndex)) return null
  return { choiceIndex, toolIndex }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstDefined(
  native: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (native[key] != null) return native[key]
  }
  return undefined
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function looksLikeJsonText(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  return (first === '{' && last === '}') || (first === '[' && last === ']')
}

function parseJsonStringValue(value: unknown): unknown {
  if (typeof value !== 'string' || !looksLikeJsonText(value)) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseKiloToolArgsObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed === 'string' && looksLikeJsonText(parsed)) {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }

  return asRecord(parsed)
}

export function tryNormalizeKiloToolCallArgumentString(
  toolName: string,
  raw: string,
): string | null {
  const args = parseKiloToolArgsObject(raw)
  if (!args) return null
  return JSON.stringify(normalizeKiloToolCallArguments(toolName, args))
}

export function normalizeKiloToolCallArgumentString(
  toolName: string,
  raw: string,
): string {
  return tryNormalizeKiloToolCallArgumentString(toolName, raw) ?? raw
}

export function normalizeKiloToolCallArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (toolName) {
    case 'AskUserQuestion':
      return normalizeKiloAskUserQuestionInput(args)
    case 'Edit':
      return normalizeKiloEditInput(args)
    case 'Read':
      return normalizeKiloReadInput(args)
    case 'Write':
      return normalizeKiloWriteInput(args)
    case 'TaskGet':
      return normalizeKiloTaskGetInput(args)
    default:
      return args
  }
}

function normalizeKiloAskUserQuestionInput(
  nativeInput: Record<string, unknown>,
): Record<string, unknown> {
  const native = { ...nativeInput }
  const parsedQuestions = parseJsonStringValue(native.questions)
  if (Array.isArray(parsedQuestions)) {
    native.questions = parsedQuestions
  } else if (asRecord(parsedQuestions)) {
    native.questions = [parsedQuestions]
  } else if (typeof parsedQuestions === 'string') {
    native.question = parsedQuestions
    delete native.questions
  }

  const rawQuestions = Array.isArray(native.questions) && native.questions.length > 0
    ? native.questions
    : [native]

  const questions = rawQuestions.map((raw, index) => {
    const record = asRecord(raw) ?? {}
    const question =
      nonEmptyString(record.question) ??
      nonEmptyString(record.prompt) ??
      nonEmptyString(raw) ??
      nonEmptyString(native.question) ??
      nonEmptyString(native.prompt) ??
      'Please choose an option.'
    const type = record.type ?? native.type

    return {
      question,
      header: askUserHeader(record.header ?? native.header, question, index),
      options: askUserOptions(record.options ?? native.options, type),
      multiSelect: asBoolean(
        record.multiSelect ??
        record.multi_select ??
        native.multiSelect ??
        native.multi_select,
      ),
    } satisfies KiloAskUserQuestion
  })

  const out: Record<string, unknown> = { questions }
  for (const key of ['answers', 'annotations', 'metadata']) {
    if (native[key] != null) out[key] = parseJsonStringValue(native[key])
  }
  return out
}

function askUserHeader(value: unknown, question: string, index: number): string {
  const explicit = nonEmptyString(value)
  if (explicit) return explicit.slice(0, 12)
  const fromQuestion = question
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  return (fromQuestion || `Q${index + 1}`).slice(0, 12)
}

function askUserOptions(rawOptions: unknown, type: unknown): KiloAskUserOption[] {
  const parsed = parseJsonStringValue(rawOptions)
  const options: KiloAskUserOption[] = []

  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i++) {
      const raw = parsed[i]
      if (typeof raw === 'string') {
        const label = raw.trim()
        if (label) options.push({ label, description: `Select ${label}.` })
        continue
      }

      const record = asRecord(raw)
      if (!record) continue
      const label =
        nonEmptyString(record.label) ??
        nonEmptyString(record.text) ??
        nonEmptyString(record.value) ??
        `Option ${i + 1}`
      const description =
        nonEmptyString(record.description) ??
        nonEmptyString(record.desc) ??
        `Select ${label}.`
      options.push({ label, description })
    }
  }

  const deduped: KiloAskUserOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const key = option.label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(option)
    if (deduped.length >= 4) break
  }

  const fallback = String(type ?? '').toLowerCase() === 'yesno'
    ? [
        { label: 'Yes', description: 'Confirm this option.' },
        { label: 'No', description: 'Decline this option.' },
      ]
    : [
        { label: 'Answer', description: 'Provide a custom answer.' },
        { label: 'Skip', description: 'Do not answer this now.' },
      ]

  for (const option of fallback) {
    if (deduped.length >= 2) break
    const key = option.label.toLowerCase()
    if (!seen.has(key)) {
      deduped.push(option)
      seen.add(key)
    }
  }

  return deduped.slice(0, 4)
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase())
  }
  return false
}

const KILO_FILE_PATH_KEYS = [
  'file_path',
  'path',
  'target_file',
  'targetFile',
  'absolute_path',
  'absolutePath',
  'relative_workspace_path',
  'relativeWorkspacePath',
  'filename',
  'file',
] as const

/**
 * The model's arguments with each alias group replaced by its canonical name.
 * Every other argument is kept: the tool's own schema decides what it takes.
 * Rebuilding the input from a fixed list silently dropped parameters the list
 * did not name — Read's `pages` and `skeleton` never reached the tool on this
 * lane, so a page range read the whole document.
 */
function withCanonicalArguments(
  native: Record<string, unknown>,
  canonical: ReadonlyArray<readonly [name: string, aliases: readonly string[]]>,
): Record<string, unknown> {
  const aliases = new Set(canonical.flatMap(([name, group]) => [name, ...group]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(native)) {
    if (!aliases.has(key)) out[key] = value
  }
  for (const [name, group] of canonical) {
    const value = firstDefined(native, [name, ...group])
    if (value !== undefined) out[name] = value
  }
  return out
}

function normalizeKiloReadInput(native: Record<string, unknown>): Record<string, unknown> {
  return withCanonicalArguments(native, [['file_path', KILO_FILE_PATH_KEYS]])
}

function normalizeKiloWriteInput(native: Record<string, unknown>): Record<string, unknown> {
  return withCanonicalArguments(native, [
    ['file_path', KILO_FILE_PATH_KEYS],
    ['content', ['contents', 'text', 'source', 'data']],
  ])
}

function normalizeKiloEditInput(native: Record<string, unknown>): Record<string, unknown> {
  return withCanonicalArguments(native, [
    ['file_path', KILO_FILE_PATH_KEYS],
    ['old_string', ['old_str', 'old_text', 'search', 'find', 'original']],
    ['new_string', ['new_str', 'new_text', 'replace', 'replacement']],
    ['replace_all', ['replaceAll', 'all', 'allow_multiple']],
  ])
}

function normalizeKiloTaskGetInput(native: Record<string, unknown>): Record<string, unknown> {
  return withCanonicalArguments(native, [['taskId', ['task_id', 'id', 'task']]])
}
