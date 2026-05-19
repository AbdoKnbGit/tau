const TOOL_RESULT_COMPRESSION_ENV_KEYS = [
  'TAU_TOOL_RESULT_COMPRESSION',
  'CLAUDE_CODE_TOOL_RESULT_COMPRESSION',
] as const

const IMPORTANT_LINE =
  /\b(error|failed?|failure|exception|traceback|panic|fatal|warn(?:ing)?|assert(?:ion)?|timeout|timed out|enoent|eacces|eperm|syntaxerror|typeerror|referenceerror)\b|(?:^|\s)[\w./\\-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|cpp|c|h|cs|sh|ps1):\d+(?::\d+)?/i

const MIN_COMPRESSIBLE_CHARS = 4096

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function isToolResultCompressionEnabled(): boolean {
  return TOOL_RESULT_COMPRESSION_ENV_KEYS.some(key =>
    isTruthyEnv(process.env[key]),
  )
}

function appendLine(
  lines: string[],
  seen: Set<string>,
  line: string,
  options?: { dedupe?: boolean },
): void {
  const trimmedRight = line.replace(/\s+$/u, '')
  if (trimmedRight.length === 0) return
  if (options?.dedupe && seen.has(trimmedRight)) return
  seen.add(trimmedRight)
  lines.push(trimmedRight)
}

function appendSection(
  out: string[],
  label: string,
  lines: readonly string[],
): void {
  if (lines.length === 0) return
  if (out.length > 0) out.push('')
  out.push(label)
  out.push(...lines)
}

function fitToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const suffix = '\n... preview trimmed to budget ...'
  if (maxChars <= suffix.length) return text.slice(0, maxChars)
  const head = text.slice(0, maxChars - suffix.length)
  const lastNewline = head.lastIndexOf('\n')
  return head.slice(0, lastNewline > 0 ? lastNewline : head.length) + suffix
}

/**
 * Deterministic preview for large plain-text tool output.
 * It is intentionally conservative: keep a small head/tail plus high-signal
 * diagnostic lines, while the full raw output remains persisted separately.
 */
export function buildCompressedToolResultPreview(
  content: string,
  maxChars: number,
): string | null {
  if (content.length < MIN_COMPRESSIBLE_CHARS) return null
  if (maxChars <= 0) return null

  const allLines = content.split(/\r?\n/u)
  if (allLines.length < 40) return null

  const seen = new Set<string>()
  const head: string[] = []
  const important: string[] = []
  const tail: string[] = []

  for (const line of allLines.slice(0, 12)) {
    appendLine(head, seen, line)
  }

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i] ?? ''
    if (!IMPORTANT_LINE.test(line)) continue
    appendLine(important, seen, `[line ${i + 1}] ${line}`, { dedupe: true })
    if (important.length >= 24) break
  }

  for (const line of allLines.slice(-16)) {
    appendLine(tail, seen, line)
  }

  if (important.length === 0 && tail.length === 0) return null

  const out: string[] = [
    `Compressed preview selected from ${allLines.length.toLocaleString('en-US')} lines.`,
  ]
  appendSection(out, '--- first lines ---', head)
  appendSection(out, '--- diagnostic lines ---', important)
  appendSection(out, '--- last lines ---', tail)

  const preview = fitToBudget(out.join('\n'), maxChars)
  return preview.length < content.length ? preview : null
}

export function selectToolResultPreview(
  fallbackPreview: string,
  originalContent: unknown,
  maxChars: number,
): string {
  if (!isToolResultCompressionEnabled() || typeof originalContent !== 'string') {
    return fallbackPreview
  }
  return (
    buildCompressedToolResultPreview(originalContent, maxChars) ??
    fallbackPreview
  )
}
