import { existsSync, statSync } from 'fs'
import { extname, isAbsolute, resolve } from 'path'

import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'

export type ChangeRiskLevel = 'low' | 'medium' | 'high'

export type ChangedFile = {
  path: string
  status?: string
  additions?: number
  deletions?: number
}

export type GitChangeSummary = {
  root: string
  isGitRepo: boolean
  changedFiles: ChangedFile[]
  additions: number
  deletions: number
  warnings: string[]
}

export type ChangeRiskAssessment = {
  level: ChangeRiskLevel
  score: number
  triggers: string[]
  reviewRecommended: boolean
  verifyRecommended: boolean
  suggestedChecks: string[]
  notes: string[]
}

const GIT_TIMEOUT_MS = 3_000
const GIT_MAX_BUFFER = 500_000

function safeStat(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

export function resolveAnalysisRoot(root: string | undefined): string {
  const cwd = getCwd()
  const value = root?.trim() ? root.trim() : cwd
  const absolute = isAbsolute(value) ? value : resolve(cwd, value)
  // A network (UNC) path is not touched here: this also runs for the
  // permission check, before anyone has agreed to contact that server.
  if (absolute.startsWith('\\\\') || absolute.startsWith('//')) return absolute
  const stat = safeStat(absolute)
  if (stat?.isFile()) {
    return resolve(absolute, '..')
  }
  return absolute
}

async function runGit(root: string, args: string[]) {
  return execFileNoThrowWithCwd('git', args, {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    preserveOutputOnError: true,
  })
}

async function resolveGitRoot(start: string): Promise<{
  root: string
  isGitRepo: boolean
  warning?: string
}> {
  const result = await runGit(start, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0 || !result.stdout.trim()) {
    return {
      root: start,
      isGitRepo: false,
      warning: `No git repository detected at ${start}.`,
    }
  }
  return { root: resolve(result.stdout.trim()), isGitRepo: true }
}

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^"|"$/g, '')
}

function parseStatus(stdout: string): ChangedFile[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2)
      const rawPath = line.slice(3).trim()
      const path = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').pop() ?? rawPath
        : rawPath
      return { path: normalizeGitPath(path), status }
    })
}

function parseNumstat(stdout: string): ChangedFile[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const [additionsRaw, deletionsRaw, ...pathParts] = line.split(/\s+/)
      const path = pathParts.join(' ')
      if (!path) return []
      const additions = additionsRaw === '-' ? 0 : Number(additionsRaw)
      const deletions = deletionsRaw === '-' ? 0 : Number(deletionsRaw)
      return [
        {
          path: normalizeGitPath(path),
          additions: Number.isFinite(additions) ? additions : 0,
          deletions: Number.isFinite(deletions) ? deletions : 0,
        },
      ]
    })
}

function mergeChangedFiles(groups: ChangedFile[][]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>()
  for (const group of groups) {
    for (const file of group) {
      const prior = byPath.get(file.path) ?? { path: file.path }
      byPath.set(file.path, {
        path: file.path,
        status: file.status ?? prior.status,
        additions: (prior.additions ?? 0) + (file.additions ?? 0),
        deletions: (prior.deletions ?? 0) + (file.deletions ?? 0),
      })
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function explicitFiles(root: string, files: readonly string[] | undefined): ChangedFile[] {
  if (!files) return []
  return files
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => {
      if (!isAbsolute(file)) return normalizeGitPath(file)
      const relative = resolve(file).startsWith(root)
        ? resolve(file).slice(root.length).replace(/^[\\/]+/, '')
        : file
      return normalizeGitPath(relative)
    })
    .map(path => ({ path, status: 'explicit' }))
}

export async function collectGitChangeSummary(
  rootInput?: string,
  changedFiles?: readonly string[],
): Promise<GitChangeSummary> {
  const start = resolveAnalysisRoot(rootInput)
  const warnings: string[] = []
  if (!existsSync(start)) {
    return {
      root: start,
      isGitRepo: false,
      changedFiles: explicitFiles(start, changedFiles),
      additions: 0,
      deletions: 0,
      warnings: [`Path does not exist: ${start}`],
    }
  }

  const git = await resolveGitRoot(start)
  if (git.warning) warnings.push(git.warning)

  if (!git.isGitRepo) {
    const files = explicitFiles(git.root, changedFiles)
    return {
      root: git.root,
      isGitRepo: false,
      changedFiles: files,
      additions: 0,
      deletions: 0,
      warnings,
    }
  }

  const [status, numstat] = await Promise.all([
    runGit(git.root, ['status', '--short', '--untracked-files=normal']),
    runGit(git.root, ['diff', '--numstat', 'HEAD', '--']),
  ])

  if (status.code !== 0) {
    warnings.push(status.stderr.trim() || 'Unable to read git status.')
  }
  if (numstat.code !== 0) {
    warnings.push(numstat.stderr.trim() || 'Unable to read git diff stats.')
  }

  const files = mergeChangedFiles([
    status.code === 0 ? parseStatus(status.stdout) : [],
    numstat.code === 0 ? parseNumstat(numstat.stdout) : [],
    explicitFiles(git.root, changedFiles),
  ])

  return {
    root: git.root,
    isGitRepo: true,
    changedFiles: files,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    warnings,
  }
}

function addTrigger(triggers: string[], trigger: string): void {
  if (!triggers.includes(trigger)) triggers.push(trigger)
}

function looksLikeTest(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    /(^|[\\/])(__tests__|tests?|specs?)([\\/]|$)/.test(lower) ||
    /\.(test|spec|unit|e2e|integration)\.[^.]+$/.test(lower) ||
    /[-_](test|spec|unit|e2e|integration)\.[^.]+$/.test(lower)
  )
}

function looksLikeSource(path: string): boolean {
  return [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.cs',
    '.rb',
    '.php',
  ].includes(extname(path).toLowerCase())
}

export function assessChangeRisk(summary: GitChangeSummary): ChangeRiskAssessment {
  let score = 0
  const triggers: string[] = []
  const notes: string[] = []
  const suggestedChecks = new Set<string>()
  const files = summary.changedFiles
  const changedLineCount = summary.additions + summary.deletions

  if (files.length === 0) {
    notes.push('No changed files detected.')
  } else if (files.length >= 20) {
    score += 4
    addTrigger(triggers, 'large file count')
  } else if (files.length >= 8) {
    score += 2
    addTrigger(triggers, 'multi-file change')
  } else {
    score += 1
  }

  if (changedLineCount >= 1_000) {
    score += 4
    addTrigger(triggers, 'large diff')
  } else if (changedLineCount >= 250) {
    score += 2
    addTrigger(triggers, 'moderate diff')
  } else if (changedLineCount >= 50) {
    score += 1
  }

  for (const file of files) {
    const path = file.path.toLowerCase()
    if (/^(package\.json|.*lock|bun\.lock|pnpm-lock\.yaml|yarn\.lock)$/.test(path)) {
      score += 2
      addTrigger(triggers, 'dependency or lockfile change')
      suggestedChecks.add('Run the repo package/workflow command that validates dependency changes.')
    }
    if (/src\/(lanes|services\/api|providers|transformers?)\//.test(path)) {
      score += 2
      addTrigger(triggers, 'provider or lane behavior')
      suggestedChecks.add('Run focused provider/lane serialization or adapter tests.')
    }
    if (/(toolresult|compact|cache|token|prompt|messages|query|streaming|toolexecution)/.test(path)) {
      score += 3
      addTrigger(triggers, 'context, token, cache, or tool-result path')
      suggestedChecks.add('Run typecheck/build and a focused tool-result or prompt-cache test when available.')
    }
    if (/(permission|auth|oauth|secret|keychain|security|sandbox)/.test(path)) {
      score += 3
      addTrigger(triggers, 'permission, auth, or security path')
      suggestedChecks.add('Run permission/auth focused tests or manual negative checks.')
    }
    if (/(agenttool|team|swarm|task|workflow)/.test(path)) {
      score += 2
      addTrigger(triggers, 'agentic workflow path')
      suggestedChecks.add('Verify agent/tool orchestration behavior with the narrowest available check.')
    }
    if (/(^|\/)(build|scripts|tsconfig|eslint|biome|vite|webpack|rollup)/.test(path)) {
      score += 2
      addTrigger(triggers, 'build or tooling path')
      suggestedChecks.add('Run the repo build/typecheck command.')
    }
  }

  const sourceChanged = files.some(file => looksLikeSource(file.path))
  const testsChanged = files.some(file => looksLikeTest(file.path))
  if (sourceChanged && !testsChanged && score >= 3) {
    score += 1
    addTrigger(triggers, 'no related test file changed')
    notes.push('Consider a focused test or verifier pass because source changed without test changes.')
  }

  if (sourceChanged) {
    suggestedChecks.add('Run the narrowest relevant test, lint, typecheck, or build command.')
  }
  if (summary.warnings.length > 0) {
    notes.push(...summary.warnings)
  }

  const level: ChangeRiskLevel =
    score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low'

  return {
    level,
    score,
    triggers,
    reviewRecommended: level !== 'low',
    verifyRecommended: files.length > 0 && (level !== 'low' || sourceChanged),
    suggestedChecks: [...suggestedChecks],
    notes,
  }
}
