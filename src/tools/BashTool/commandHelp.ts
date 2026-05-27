/**
 * Command help fetcher — appends verified syntax to bash failure guidance
 * when the model used wrong flags or unknown options.
 *
 * Architecture: REACTIVE. Only invoked on bash failures whose output
 * matches a usage/invalid-option signature. Zero cost on the success
 * path. Bounded cost on failure (3s timeout per --help call).
 *
 * Source hierarchy (most → least authoritative):
 *   1. `<cmd> [subcmd] --help` — version-exact, local, deterministic.
 *      This is the actual contract the installed binary enforces.
 *   2. `<cmd> [subcmd] -h` — fallback for tools that don't accept --help.
 *
 * In-memory cache keyed by `<cmd> <subcmd>` for the session lifetime.
 * Binaries don't change mid-session, so cache once and reuse forever.
 * Negative cache prevents re-spawning processes for commands we've
 * already learned don't have usable --help output.
 */

import { spawn } from 'child_process'

const HELP_TIMEOUT_MS = 3000
const MAX_HELP_LINES = 35
const MAX_CACHE_ENTRIES = 50
const MIN_USEFUL_HELP_CHARS = 40

/**
 * Output patterns that indicate the failure was caused by the model
 * using wrong flags / arguments — exactly the cases where authoritative
 * --help output would help. Kept tight on purpose: a broad match would
 * fire on every failure and pay the spawn cost unnecessarily.
 */
const USAGE_FAILURE_PATTERNS = [
  /\busage:/i,
  /\binvalid (option|argument|flag|value|choice)\b/i,
  /\bunknown (option|flag|command|argument|switch)\b/i,
  /\bunrecognized (option|argument)\b/i,
  /\brequires an argument\b/i,
  /\bmissing (operand|argument|required)\b/i,
  /\bargument .+ is required\b/i,
  /\bno such option\b/i,
  /\bunexpected argument\b/i,
  /\bexpected one of\b/i,
  /\berror: unknown\b/i,
  /\bsee '?.+ --help'?\b/i,
  /\btry '?.+ --help'?\b/i,
]

/**
 * CLIs that take a subcommand whose --help is more specific than the
 * top-level one. For `docker run --foo`, we want `docker run --help`,
 * not `docker --help` (which only lists subcommands).
 */
const SUBCOMMAND_TOOLS = new Set([
  'docker', 'podman', 'docker-compose', 'nerdctl',
  'kubectl', 'oc', 'helm', 'k3s', 'k0s', 'kustomize',
  'git', 'gh', 'glab', 'hub',
  'npm', 'yarn', 'pnpm', 'bun', 'npx',
  'cargo', 'go', 'rustup',
  'pip', 'pip3', 'poetry', 'uv', 'conda',
  'aws', 'gcloud', 'az', 'doctl', 'flyctl', 'heroku',
  'terraform', 'pulumi', 'ansible', 'salt',
  'systemctl', 'journalctl', 'service',
  'mvn', 'gradle', 'sbt',
  'composer', 'bundle', 'gem',
  'dotnet', 'nuget',
  'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper',
  'firebase', 'vercel', 'netlify', 'supabase',
  'wrangler', 'cdk',
])

/**
 * Commands we never invoke with --help. Either dangerous, side-effecting,
 * or shell builtins where --help is meaningless.
 */
const HELP_BLOCKLIST = new Set([
  // Destructive
  'rm', 'dd', 'mkfs', 'fdisk', 'parted', 'shred', 'wipefs',
  // System control
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'kill', 'killall', 'pkill',
  // Shell builtins
  'cd', 'pwd', 'export', 'source', 'set', 'unset', 'alias', 'eval', 'exec',
  // Already covered elsewhere
  'true', 'false', ':', '.', '[',
])

interface HelpEntry {
  content: string
  source: 'help' | '-h'
}

const _cache = new Map<string, HelpEntry>()
const _negativeCache = new Set<string>()

/**
 * Returns true when the failure output looks like a syntax/usage error
 * the binary's own --help would resolve.
 */
export function isUsageFailure(output: string): boolean {
  if (!output) return false
  return USAGE_FAILURE_PATTERNS.some(rx => rx.test(output))
}

/**
 * Extract `<cmd>` or `<cmd> <subcmd>` from a bash command line. Returns
 * null when the command shouldn't be looked up (blocklist, empty, etc.).
 *
 * Handles env-var prefixes (`FOO=bar cmd ...`), full paths
 * (`/usr/bin/docker run`), and .exe suffixes.
 */
export function extractCommandKey(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  // Split on shell metacharacters so we only look at the first invocation.
  // For `cd dir && docker run img`, we'd ideally key on `docker run`, but
  // the failure usually reports which subcommand actually ran. Keeping
  // it simple: just the first command in the chain.
  const firstClause = trimmed.split(/[;&|]{1,2}|\n/)[0]?.trim()
  if (!firstClause) return null

  const parts = firstClause.split(/\s+/)
  let i = 0

  // Strip leading env-var assignments (`PYTHONIOENCODING=utf-8 python ...`)
  while (i < parts.length && /^[A-Z_][A-Z0-9_]*=/.test(parts[i] ?? '')) i++
  if (i >= parts.length) return null

  let baseRaw = parts[i]!
  // Strip path: /usr/bin/docker -> docker, C:\bin\git.exe -> git
  baseRaw = baseRaw.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
  const base = baseRaw.toLowerCase()

  if (!base || HELP_BLOCKLIST.has(base)) return null

  if (SUBCOMMAND_TOOLS.has(base)) {
    for (let j = i + 1; j < parts.length; j++) {
      const tok = parts[j]!
      if (!tok) continue
      if (tok.startsWith('-')) continue
      // Don't cross shell metacharacters or quote tokens
      if (/^["'`(){}<>]/.test(tok)) break
      return `${base} ${tok.toLowerCase()}`
    }
  }
  return base
}

interface SpawnResult {
  stdout: string
  stderr: string
  code: number
}

function spawnWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnResult | null> {
  return new Promise(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''

    let proc
    try {
      proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Prevent pagers from blocking on TTY
        env: { ...process.env, MANPAGER: 'cat', PAGER: 'cat', GIT_PAGER: 'cat' },
        // shell:false to avoid quoting surprises on Windows
        shell: false,
      })
    } catch {
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      resolve(null)
    }, timeoutMs)

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

/**
 * Extract the most useful slice of --help output. Most CLIs follow a
 * loose convention: a usage line, then sections like "Options:" or
 * "Flags:" with one-line-per-flag entries. We:
 *   1. Find the OPTIONS / FLAGS section if it exists, take from there.
 *   2. Otherwise take the whole thing.
 *   3. Cap at MAX_HELP_LINES so a single help block can't dominate context.
 */
export function summarizeHelp(help: string): string {
  const normalized = help.replace(/\r\n/g, '\n').replace(/\x1b\[[0-9;]*m/g, '')
  const allLines = normalized.split('\n')

  // Find first section header that introduces options/flags
  const sectionRx = /^\s*(options|flags|arguments|commands|subcommands)\s*:?\s*$/i
  const startIdx = allLines.findIndex(l => sectionRx.test(l))

  // Always preserve the usage line(s) at the top if present
  const usageLines: string[] = []
  for (const line of allLines) {
    if (/^\s*(usage|synopsis)\s*:/i.test(line)) {
      usageLines.push(line)
      continue
    }
    if (usageLines.length > 0) {
      // continuation lines (indented) of the usage block
      if (/^\s+\S/.test(line) && !sectionRx.test(line)) {
        usageLines.push(line)
        continue
      }
      break
    }
  }

  let body: string[]
  if (startIdx >= 0) {
    body = allLines.slice(startIdx, startIdx + MAX_HELP_LINES * 2)
  } else {
    body = allLines.slice(0, MAX_HELP_LINES * 2)
  }

  // Collapse runs of blank lines
  const collapsed: string[] = []
  let prevBlank = false
  for (const line of body) {
    const blank = line.trim() === ''
    if (blank && prevBlank) continue
    collapsed.push(line)
    prevBlank = blank
  }

  // Combine usage + body, dedupe usage lines that already appear in body
  const usageSet = new Set(usageLines.map(l => l.trim()))
  const filteredBody = collapsed.filter(l => !usageSet.has(l.trim()) || usageSet.size === 0)

  const out = [...usageLines, ...(usageLines.length ? [''] : []), ...filteredBody]
    .slice(0, MAX_HELP_LINES)
    .join('\n')
    .trimEnd()

  return out
}

function trimCache(): void {
  while (_cache.size > MAX_CACHE_ENTRIES) {
    const first = _cache.keys().next().value
    if (first === undefined) break
    _cache.delete(first)
  }
}

async function fetchHelpForKey(key: string): Promise<HelpEntry | null> {
  const parts = key.split(' ')
  const base = parts[0]!
  const sub = parts[1]

  // Try --help first (most universal)
  const longArgs = sub ? [sub, '--help'] : ['--help']
  const long = await spawnWithTimeout(base, longArgs, HELP_TIMEOUT_MS)
  if (long) {
    const out = (long.stdout || long.stderr).trim()
    // Some tools print usage to stderr with exit code != 0 even on --help; accept either
    if (out.length >= MIN_USEFUL_HELP_CHARS && !/^[a-z0-9_-]+: command not found/i.test(out)) {
      return { content: summarizeHelp(out), source: 'help' }
    }
  }

  // Fallback: -h
  const shortArgs = sub ? [sub, '-h'] : ['-h']
  const short = await spawnWithTimeout(base, shortArgs, HELP_TIMEOUT_MS)
  if (short) {
    const out = (short.stdout || short.stderr).trim()
    if (out.length >= MIN_USEFUL_HELP_CHARS && !/^[a-z0-9_-]+: command not found/i.test(out)) {
      return { content: summarizeHelp(out), source: '-h' }
    }
  }

  return null
}

/**
 * Fetch verified syntax for a command. Returns null on miss/timeout.
 * Caches positive AND negative results for session lifetime.
 */
export async function fetchCommandHelp(
  command: string,
): Promise<{ key: string; entry: HelpEntry } | null> {
  const key = extractCommandKey(command)
  if (!key) return null

  const cached = _cache.get(key)
  if (cached) return { key, entry: cached }
  if (_negativeCache.has(key)) return null

  const entry = await fetchHelpForKey(key)
  if (!entry) {
    _negativeCache.add(key)
    return null
  }

  _cache.set(key, entry)
  trimCache()
  return { key, entry }
}

/**
 * Append a "Verified syntax" block to existing failure output, but ONLY
 * if the failure output matches a usage/invalid-option pattern. This is
 * the gate that keeps zero-cost-on-success — we never spawn --help
 * unless we already know the model probably hallucinated a flag.
 *
 * Safe to call on any failure output: returns input unchanged when the
 * failure isn't a usage error, the command isn't lookup-able, or the
 * --help fetch fails/times out.
 */
export async function maybeAppendCommandHelp(
  command: string,
  failureOutput: string,
): Promise<string> {
  if (!isUsageFailure(failureOutput)) return failureOutput
  if (failureOutput.includes('Verified syntax (from ')) return failureOutput

  const result = await fetchCommandHelp(command)
  if (!result) return failureOutput

  const flag = result.entry.source === 'help' ? '--help' : '-h'
  const block = [
    '',
    `Verified syntax (from \`${result.key} ${flag}\` — authoritative for this binary):`,
    result.entry.content,
  ].join('\n')

  return `${failureOutput.trimEnd()}\n${block}`
}

/** Test hook: clear all cached help entries (positive + negative). */
export function resetCommandHelpCache(): void {
  _cache.clear()
  _negativeCache.clear()
}

/** Test hook: prime the cache directly to skip spawning in tests. */
export function _primeCacheForTest(key: string, entry: HelpEntry): void {
  _cache.set(key, entry)
}
