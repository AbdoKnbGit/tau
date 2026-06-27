import {
  rewriteUnquotedUrlAmpersand,
  tokenizeShellSegment,
  type ShellWord,
} from '../../utils/bash/defensiveRewrites.js'

/**
 * Detect commands that detach a process with a raw `&`.
 *
 * Detached processes are invisible to Tau's task tracking — they cannot be
 * listed or stopped later, and they keep holding ports and file locks (the
 * classic source of "Device or resource busy" retry loops when the model
 * later tries to restart a server or delete its database).
 * `run_in_background` gives the same concurrency with a tracked, killable
 * task, so a raw `&` is blocked with that redirection.
 *
 * Conservative by design — false blocks are worse than misses:
 * - bails out entirely on heredocs (their bodies may legitimately contain `&`)
 * - ignores `&` inside single- or double-quoted strings
 * - ignores `&&`, `|&`, and redirection forms (`2>&1`, `&>`, `<&`)
 * - allows job-control parallelism that reaps its jobs with `wait`
 */
export function detectDetachedBackgroundPattern(command: string): string | null {
  // A `&` that is part of a URL query string (`?a=1&b=2`) is auto-quoted at
  // execution time (applyBashDefensiveRewrites → rewriteUnquotedUrlAmpersand), so
  // apply the same rewrite here first: the quoted URL is then stripped below and
  // never read as a background operator. A real trailing background `&` survives.
  command = rewriteUnquotedUrlAmpersand(command)

  // Heredoc bodies may contain `&` as data (e.g. writing a script); skip the
  // whole check rather than risk a false block.
  if (/<<-?\s*['"]?\w+/.test(command)) return null

  // Strip quoted segments so `echo "fish & chips"` is not flagged.
  const stripped = command
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')

  // `wait` reaps the background jobs before the command returns — that is
  // intentional in-command parallelism, nothing stays detached.
  if (/(^|[\s;&|(])wait([\s;)]|$)/.test(stripped)) return null

  // A background `&`: not `&&`, not `|&`, not redirection (`>&`, `&>`, `<&`).
  if (!/(?<![&><|])&(?![&>])/.test(stripped)) return null

  return 'this command detaches a process with a raw `&`'
}

function hasHeredoc(command: string): boolean {
  return /<<-?\s*['"]?\w+/.test(command)
}

function stripQuotedSegments(command: string): string {
  return command
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
}

function hasReapingWait(command: string): boolean {
  return /(^|[\s;&|(])wait([\s;)]|$)/.test(stripQuotedSegments(command))
}

function isUrlQueryAmpersand(command: string, index: number): boolean {
  let start = index - 1
  while (start >= 0 && !/[\s;&|()<>]/.test(command[start]!)) start--
  start++

  let end = index + 1
  while (end < command.length && !/[\s;&|()<>]/.test(command[end]!)) end++

  const token = command.slice(start, end)
  const ampOffset = index - start
  return (
    /^https?:\/\//i.test(token) &&
    token.slice(0, ampOffset).includes('?')
  )
}

function findRawBackgroundOperators(command: string): number[] {
  const positions: number[] = []
  let inSingle = false
  let inDouble = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (inSingle) {
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (char === '\\' && index + 1 < command.length) {
        index++
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      index++
      continue
    }
    if (char === "'") {
      inSingle = true
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }
    if (char !== '&') continue

    const prev = command[index - 1]
    const next = command[index + 1]
    if (prev === '&' || next === '&') continue
    if (prev === '|' || prev === '>' || prev === '<') continue
    if (next === '>') continue
    if (isUrlQueryAmpersand(command, index)) continue
    positions.push(index)
  }

  return positions
}

const PID_TOKEN_RE = String.raw`(?:"\$\!"|'\$\!'|\$\!)`
const SIMPLE_REDIRECT_RE = String.raw`(?:\s*(?:>|>>)\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+))?`

function splitSuffixCommands(suffix: string): string[] {
  return suffix
    .trim()
    .replace(/^;\s*/, '')
    .split(/\s*(?:;|&&)\s*/)
    .map(part => part.trim())
    .filter(Boolean)
}

function isPidMetadataCommand(command: string): boolean {
  return new RegExp(
    String.raw`^echo(?:\s+-n)?\s+${PID_TOKEN_RE}${SIMPLE_REDIRECT_RE}$`,
  ).test(command) || new RegExp(
    String.raw`^printf\s+(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)\s+${PID_TOKEN_RE}${SIMPLE_REDIRECT_RE}$`,
  ).test(command) || /^[A-Za-z_][A-Za-z0-9_]*=\$!$/.test(command)
}

function isDisownCommand(command: string): boolean {
  return /^disown(?:\s+-[A-Za-z]+)?(?:\s+%\d+)?$/.test(command)
}

function hasUnquotedShellControl(command: string): boolean {
  return /[<>|&]/.test(stripQuotedSegments(command))
}

function isBenignStatusCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed.includes('$') || trimmed.includes('`')) return false
  if (hasUnquotedShellControl(trimmed)) return false

  return /^echo(?:\s+-[A-Za-z]+)*(?:\s+.+)?$/.test(trimmed) || /^printf\s+(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s<>|&;]+)(?:\s+(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s<>|&;]+))*$/.test(trimmed)
}

function isIgnorableDetachSuffix(suffix: string): boolean {
  const commands = splitSuffixCommands(suffix)
  return commands.length === 0 || commands.every(command =>
    isPidMetadataCommand(command) ||
    isDisownCommand(command) ||
    isBenignStatusCommand(command),
  )
}

function stripRedundantDetachWrappers(command: string): string {
  return command.replace(
    /(^|(?:&&|\|\||;|\()\s*)((?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|\S+)\s+)*)nohup\s+/g,
    '$1$2',
  )
}

function commandBasename(value: string): string {
  return value.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase()
}

function findShellSegments(command: string): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = []
  let start = 0
  let inSingle = false
  let inDouble = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (inSingle) {
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (char === '\\' && index + 1 < command.length) {
        index++
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      index++
      continue
    }
    if (char === "'") {
      inSingle = true
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }

    const prev = command[index - 1]
    const next = command[index + 1]
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      segments.push({ start, end: index })
      start = index + 2
      index++
      continue
    }
    if (char === ';' || char === '\n') {
      segments.push({ start, end: index })
      start = index + 1
      continue
    }
    if (char === '|' && next !== '&') {
      segments.push({ start, end: index })
      start = index + 1
      continue
    }
    if (char === '&' && prev !== '>' && prev !== '<' && prev !== '|' && next !== '>') {
      segments.push({ start, end: index })
      start = index + 1
    }
  }

  segments.push({ start, end: command.length })
  return segments.filter(segment => command.slice(segment.start, segment.end).trim().length > 0)
}

function findFinalShellSegment(command: string): { start: number; end: number } {
  return findShellSegments(command).at(-1) ?? { start: 0, end: command.length }
}

function firstExecutableIndex(words: ShellWord[]): number {
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!.value)) {
    index++
  }
  return index
}

const DOCKER_COMPOSE_VALUE_FLAGS = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--env-file',
  '--project-directory',
  '--parallel',
  '--ansi',
  '--progress',
  '--log-level',
])

const DOCKER_RUN_VALUE_FLAGS = new Set([
  '-a',
  '--attach',
  '--add-host',
  '--annotation',
  '--blkio-weight',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cidfile',
  '--cpus',
  '--cpuset-cpus',
  '--device',
  '--device-cgroup-rule',
  '--dns',
  '--dns-option',
  '--dns-search',
  '-e',
  '--env',
  '--env-file',
  '--entrypoint',
  '--expose',
  '--gpus',
  '-h',
  '--hostname',
  '--ip',
  '--ip6',
  '-l',
  '--label',
  '--label-file',
  '-m',
  '--memory',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '-p',
  '--publish',
  '--pull',
  '--restart',
  '--stop-signal',
  '--stop-timeout',
  '--user',
  '-u',
  '-v',
  '--volume',
  '--volumes-from',
  '-w',
  '--workdir',
])

function isDetachFlag(value: string): boolean {
  return value === '-d' || value === '--detach' || value === '--detach=true'
}

function flagName(value: string): string {
  return value.startsWith('--') ? value.split('=')[0]! : value
}

function removeWordRanges(segment: string, ranges: Array<{ start: number; end: number }>): string {
  let out = segment
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    let start = range.start
    let end = range.end
    while (end < out.length && /\s/.test(out[end]!)) end++
    if (end === range.end) {
      while (start > 0 && /\s/.test(out[start - 1]!)) start--
    }
    out = out.slice(0, start) + out.slice(end)
  }
  return out
}

function findDockerComposeUpDetachRanges(words: ShellWord[]): Array<{ start: number; end: number }> {
  const executableIndex = firstExecutableIndex(words)
  const executable = words[executableIndex]
  if (!executable) return []

  const head = commandBasename(executable.value)
  let index = executableIndex + 1
  if (head === 'docker') {
    if (words[index]?.value !== 'compose') return []
    index++
  } else if (head !== 'docker-compose') {
    return []
  }

  let upIndex = -1
  for (; index < words.length; index++) {
    const value = words[index]!.value
    if (value === 'up') {
      upIndex = index
      break
    }
    if (value.startsWith('-') && !value.includes('=') && DOCKER_COMPOSE_VALUE_FLAGS.has(value)) {
      index++
    }
  }
  if (upIndex < 0) return []

  return words
    .slice(upIndex + 1)
    .filter(word => isDetachFlag(word.value))
    .map(({ start, end }) => ({ start, end }))
}

function findDockerRunDetachRanges(words: ShellWord[]): Array<{ start: number; end: number }> {
  const executableIndex = firstExecutableIndex(words)
  const executable = words[executableIndex]
  if (!executable || commandBasename(executable.value) !== 'docker') return []

  let runIndex = -1
  for (let index = executableIndex + 1; index < words.length; index++) {
    const value = words[index]!.value
    if (value === 'run') {
      runIndex = index
      break
    }
    if (value.startsWith('-') && !value.includes('=') && DOCKER_RUN_VALUE_FLAGS.has(value)) {
      index++
    }
  }
  if (runIndex < 0) return []

  const ranges: Array<{ start: number; end: number }> = []
  for (let index = runIndex + 1; index < words.length; index++) {
    const word = words[index]!
    const value = word.value
    if (isDetachFlag(value)) {
      ranges.push({ start: word.start, end: word.end })
      continue
    }
    if (value === '--') break
    if (!value.startsWith('-')) break
    if (!value.includes('=') && DOCKER_RUN_VALUE_FLAGS.has(flagName(value))) {
      index++
    }
  }

  return ranges
}

function repairCliDetachCommand(command: string): string | null {
  const segment = findFinalShellSegment(command)
  const segmentText = command.slice(segment.start, segment.end)
  const words = tokenizeShellSegment(segmentText)
  const ranges = findCliDetachRanges(words)
  if (ranges.length === 0) return null

  const repairedSegment = removeWordRanges(segmentText, ranges)
  const repaired = command.slice(0, segment.start) + repairedSegment + command.slice(segment.end)
  return repaired.trim().length > 0 && repaired !== command ? repaired : null
}

function findCliDetachRanges(words: ShellWord[]): Array<{ start: number; end: number }> {
  return [
    ...findDockerComposeUpDetachRanges(words),
    ...findDockerRunDetachRanges(words),
  ]
}

function detectCliDetachPattern(command: string): string | null {
  for (const segment of findShellSegments(command)) {
    const words = tokenizeShellSegment(command.slice(segment.start, segment.end))
    if (findCliDetachRanges(words).length > 0) {
      return 'this command detaches containers with a CLI detach flag'
    }
  }
  return null
}

function repairRawShellDetachCommand(command: string): string | null {
  if (detectDetachedBackgroundPattern(command) === null) return null

  const positions = findRawBackgroundOperators(command)
  if (positions.length !== 1) return null

  const index = positions[0]!
  const suffix = command.slice(index + 1)
  if (!isIgnorableDetachSuffix(suffix)) return null

  const repaired = stripRedundantDetachWrappers(command.slice(0, index).trimEnd())
  return repaired.length > 0 ? repaired : null
}

export function repairDetachedBackgroundCommand(
  command: string,
): string | null {
  if (hasHeredoc(command) || hasReapingWait(command)) return null

  return (
    repairRawShellDetachCommand(command) ??
    repairCliDetachCommand(command)
  )
}

export function buildDetachedBackgroundValidationMessage(
  command: string,
  runInBackground: boolean,
): string | null {
  const detachPattern = detectDetachedBackgroundPattern(command)
  if (detachPattern !== null) {
    const retryGuidance = runInBackground
      ? 'Remove the shell backgrounding from the command; run_in_background: true already starts the whole command as a tracked background task.'
      : 'Retry by removing the shell backgrounding from the command and setting run_in_background: true on the Bash tool call.'

    return `Blocked: ${detachPattern}. Detached processes are untracked - they cannot be listed or stopped later, and they keep holding ports and file locks. ${retryGuidance} Keep log redirection if needed, but do not append \`&\`, \`nohup\`, \`disown\`, or \`echo $!\`. For intentional in-command parallelism, end the command with \`wait\`. If the \`&\` is part of a URL or argument value, quote that argument - unquoted it backgrounds the command in bash.`
  }

  const cliDetachPattern = detectCliDetachPattern(command)
  if (cliDetachPattern === null) return null

  return `Blocked: ${cliDetachPattern}. Detached containers are untracked - Tau cannot stop them later and they can keep ports and files locked. Remove Docker detach flags such as \`-d\`, \`--detach\`, \`docker compose up -d\`, and \`docker run -d\`; run the foreground form with run_in_background: true instead.`
}

function hasUnquotedForegroundStdinTopology(command: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (inSingle) {
      if (char === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (char === '\\' && index + 1 < command.length) {
        index++
        continue
      }
      if (char === '"') inDouble = false
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      index++
      continue
    }
    if (char === "'") {
      inSingle = true
      continue
    }
    if (char === '"') {
      inDouble = true
      continue
    }

    if (
      char === '|' &&
      command[index - 1] !== '|' &&
      command[index + 1] !== '|' &&
      command[index + 1] !== '&'
    ) {
      return true
    }
    if (char === '<') {
      // Input redirects, heredocs/here-strings, and process substitution all
      // couple the foreground shell to an input producer/descriptor.
      return true
    }
  }
  return false
}

/**
 * Automatic backgrounding is safe only for commands whose lifecycle is not
 * coupled to foreground stdin. Moving a pipeline/heredoc/input redirect to the
 * task system mid-flight can sever or outlive its producer and make a finite
 * command appear hung. Explicit run_in_background remains available.
 */
export function allowsAutomaticBackgrounding(command: string): boolean {
  const trimmed = command.trim()
  const firstWord = /^[A-Za-z_][A-Za-z0-9_]*=(?:\S+)\s+/.test(trimmed)
    ? trimmed.replace(
        /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/,
        '',
      ).split(/\s+/)[0]
    : trimmed.split(/\s+/)[0]

  if (firstWord === 'sleep') return false
  return !hasUnquotedForegroundStdinTopology(command)
}
