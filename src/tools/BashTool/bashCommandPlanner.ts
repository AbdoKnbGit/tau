import { getCwd } from '../../utils/cwd.js'
import { compileBashCommandParts, type BashCommandParts } from './bashCommandParts.js'
import { extractCommandKey, fetchCommandHelp } from './commandHelp.js'
import { validateBashExecutionPreflight } from './bashPreflightValidation.js'
import { validateBashSyntax } from './bashSyntaxValidation.js'
import { analyzeNativeShellCommand, type NativeShellAnalysis } from './nativeShellParser.js'

export type BashCommandPlannerInput = {
  command: string
  workdir?: string
  timeout?: number
  run_in_background?: boolean
  plan_only?: boolean
  syntax_confirmed?: boolean
  dangerouslyDisableSandbox?: boolean
  command_parts?: BashCommandParts
}

export type BashCommandDomain =
  | 'container'
  | 'kubernetes'
  | 'git'
  | 'package-manager'
  | 'python'
  | 'test-runner'
  | 'build-runner'
  | 'cloud'
  | 'service'
  | 'external-cli'
  | 'shell'

export type BashCommandPlanningInfo = {
  key: string | null
  base: string | null
  subcommand: string | null
  domain: BashCommandDomain
  complexity: string[]
  discoveryCommands: string[]
  isDiscoveryCommand: boolean
}

export type BashAutoPlanDecision = {
  required: boolean
  reasons: string[]
  info: BashCommandPlanningInfo
}

const DOMAIN_BY_BASE: Record<string, BashCommandDomain> = {
  docker: 'container',
  podman: 'container',
  'docker-compose': 'container',
  nerdctl: 'container',
  kubectl: 'kubernetes',
  oc: 'kubernetes',
  helm: 'kubernetes',
  k3s: 'kubernetes',
  k0s: 'kubernetes',
  kustomize: 'kubernetes',
  git: 'git',
  gh: 'git',
  glab: 'git',
  hub: 'git',
  npm: 'package-manager',
  yarn: 'package-manager',
  pnpm: 'package-manager',
  bun: 'package-manager',
  npx: 'package-manager',
  python: 'python',
  python3: 'python',
  py: 'python',
  pytest: 'test-runner',
  vitest: 'test-runner',
  jest: 'test-runner',
  mocha: 'test-runner',
  playwright: 'test-runner',
  cypress: 'test-runner',
  go: 'build-runner',
  cargo: 'build-runner',
  dotnet: 'build-runner',
  mvn: 'build-runner',
  gradle: 'build-runner',
  make: 'build-runner',
  just: 'build-runner',
  aws: 'cloud',
  gcloud: 'cloud',
  az: 'cloud',
  doctl: 'cloud',
  flyctl: 'cloud',
  heroku: 'cloud',
  terraform: 'cloud',
  pulumi: 'cloud',
  systemctl: 'service',
  journalctl: 'service',
  service: 'service',
}

const SHELL_BUILTINS = new Set([
  'cd',
  'pwd',
  'echo',
  'printf',
  'test',
  '[',
  'true',
  'false',
  'export',
  'source',
  'set',
  'unset',
  'alias',
])

const READ_LIKE_BASES = new Set([
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'sed',
  'awk',
  'jq',
  'grep',
  'rg',
  'find',
  'tree',
  'wc',
  'stat',
  'file',
  'pwd',
])

const AUTO_PLAN_DOMAINS = new Set<BashCommandDomain>([
  'container',
  'kubernetes',
  'package-manager',
  'python',
  'test-runner',
  'build-runner',
  'cloud',
  'service',
])

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function firstClause(command: string): string {
  return command.trim().split(/[;&|]{1,2}|\n/)[0]?.trim() ?? ''
}

function tokenizeSimple(command: string): string[] {
  const clause = firstClause(command)
  if (!clause) return []
  return clause.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
}

function unquote(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1)
  }
  return token
}

function stripExecutable(raw: string): string {
  return raw.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
}

function getBaseCommand(command: string): string | null {
  const tokens = tokenizeSimple(command)
  let i = 0
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i] ?? '')) i++
  const raw = tokens[i]
  if (!raw) return null
  const base = stripExecutable(unquote(raw))
  return base || null
}

function getSubcommandFromKey(key: string | null): string | null {
  if (!key) return null
  const [, subcommand] = key.split(' ')
  return subcommand ?? null
}

function detectDomain(base: string | null, key: string | null): BashCommandDomain {
  if (!base) return 'shell'
  if (SHELL_BUILTINS.has(base)) return 'shell'
  if (base === 'go' && getSubcommandFromKey(key) === 'test') return 'test-runner'
  if (base === 'cargo' && getSubcommandFromKey(key) === 'test') return 'test-runner'
  if (base === 'dotnet' && getSubcommandFromKey(key) === 'test') return 'test-runner'
  return DOMAIN_BY_BASE[base] ?? 'external-cli'
}

function detectComplexity(command: string, key: string | null): string[] {
  const tokens = tokenizeSimple(command)
  const flags = tokens.filter(token => /^-{1,2}[^-]/.test(token)).length
  const complexity: string[] = []

  if (command.length > 140) complexity.push('long command')
  if (tokens.length >= 8) complexity.push('many arguments')
  if (flags >= 3) complexity.push('multiple flags')
  if (/[{}[\]]/.test(command)) complexity.push('structured data or glob syntax')
  if (/["']/.test(command)) complexity.push('quoting required')
  if (/[|<>;]/.test(command) || /&&|\|\|/.test(command)) complexity.push('shell operators')
  if (key?.includes(' ')) complexity.push('external subcommand syntax')

  return complexity.length > 0 ? complexity : ['simple command shape']
}

function isDiscoveryCommand(command: string): boolean {
  const normalized = firstClause(command).toLowerCase()
  if (!normalized) return false
  if (/\s--help(?:\s|$)/.test(normalized)) return true
  if (/\s-h(?:\s|$)/.test(normalized)) return true
  if (/\shelp(?:\s|$)/.test(normalized)) return true
  if (/\s--version(?:\s|$)/.test(normalized)) return true
  if (/\sversion(?:\s|$)/.test(normalized)) return true
  if (/^(which|whereis|command -v|type)\s+/.test(normalized)) return true
  if (/^(cat|sed -n|head)\s+.*(package\.json|pyproject\.toml|pytest\.ini|go\.mod|cargo\.toml|makefile|justfile)/.test(normalized)) return true
  if (/^rg\s+.*(argparse|click|typer|commander|program\.command|add_argument)/.test(normalized)) return true
  if (/^rg --files\b/.test(normalized)) return true
  return false
}

function pythonModuleHelpCommand(command: string): string | null {
  const tokens = tokenizeSimple(command).map(unquote)
  const baseIndex = tokens.findIndex(token => {
    const base = stripExecutable(token)
    return base === 'python' || base === 'python3' || base === 'py'
  })
  if (baseIndex < 0) return null
  const moduleFlagIndex = tokens.indexOf('-m', baseIndex + 1)
  const moduleName = moduleFlagIndex >= 0 ? tokens[moduleFlagIndex + 1] : undefined
  if (!moduleName || moduleName.startsWith('-')) return null
  const pythonBin = tokens[baseIndex] ?? 'python'
  return `${pythonBin} -m ${moduleName} --help`
}

function helpCommandForKey(key: string | null): string | null {
  if (!key) return null
  const [base, subcommand] = key.split(' ')
  if (!base) return null
  if (base === 'git' && subcommand) return `git ${subcommand} -h`
  return subcommand ? `${base} ${subcommand} --help` : `${base} --help`
}

function recommendedDiscoveryCommands(
  command: string,
  domain: BashCommandDomain,
  key: string | null,
): string[] {
  const suggestions: string[] = []
  const baseHelp = helpCommandForKey(key)
  if (baseHelp) suggestions.push(baseHelp)

  if (domain === 'package-manager') {
    suggestions.push('cat package.json')
    const base = key?.split(' ')[0]
    if (base === 'pnpm' || base === 'npm' || base === 'yarn' || base === 'bun') {
      suggestions.push(`${base} run`)
    }
  }

  if (domain === 'python' || domain === 'test-runner') {
    const moduleHelp = pythonModuleHelpCommand(command)
    if (moduleHelp) suggestions.unshift(moduleHelp)
    suggestions.push('rg -n "argparse|click|typer|if __name__" .')
    suggestions.push('cat pyproject.toml')
  }

  if (domain === 'build-runner') {
    suggestions.push('cat Makefile')
    suggestions.push('cat justfile')
    suggestions.push('cat pyproject.toml')
    suggestions.push('cat package.json')
  }

  if (domain === 'container') {
    suggestions.push('docker compose config')
    suggestions.push('cat docker-compose.yml')
  }

  if (domain === 'git') {
    suggestions.push('git status --short')
  }

  return unique(suggestions).slice(0, 6)
}

function complexityScore(complexity: string[]): number {
  return complexity.filter(item => item !== 'simple command shape').length
}

export function analyzeBashCommandPlanning(
  input: BashCommandPlannerInput,
): BashCommandPlanningInfo {
  const key = extractCommandKey(input.command)
  const base = getBaseCommand(input.command)
  const subcommand = getSubcommandFromKey(key)
  const domain = detectDomain(base, key)
  const complexity = detectComplexity(input.command, key)
  const discoveryCommand = isDiscoveryCommand(input.command)
  const discoveryCommands = discoveryCommand
    ? []
    : recommendedDiscoveryCommands(input.command, domain, key)

  return {
    key,
    base,
    subcommand,
    domain,
    complexity,
    discoveryCommands,
    isDiscoveryCommand: discoveryCommand,
  }
}

export function shouldAutoPlanBashCommand(
  input: BashCommandPlannerInput,
): BashAutoPlanDecision {
  const info = analyzeBashCommandPlanning(input)
  const score = complexityScore(info.complexity)
  const reasons: string[] = []

  if (
    input.plan_only ||
    input.syntax_confirmed ||
    input.command_parts ||
    info.isDiscoveryCommand ||
    !info.base ||
    READ_LIKE_BASES.has(info.base) ||
    info.domain === 'shell'
  ) {
    return {
      required: false,
      reasons,
      info,
    }
  }

  if (AUTO_PLAN_DOMAINS.has(info.domain) && score >= 2) {
    reasons.push(`complex ${info.domain} command`)
  }

  if (info.domain === 'git' && score >= 3) {
    reasons.push('complex git command')
  }

  if (info.domain === 'external-cli' && score >= 3) {
    reasons.push('complex external CLI command')
  }

  if (input.command.length > 220 && info.domain !== 'shell') {
    reasons.push('very long external command')
  }

  return {
    required: reasons.length > 0,
    reasons,
    info,
  }
}

export async function renderBashAutoPlanMessage(
  input: BashCommandPlannerInput,
  cwd = getCwd(),
): Promise<string | null> {
  const decision = shouldAutoPlanBashCommand(input)
  if (!decision.required) return null

  const plan = await renderBashCommandPlan(input, cwd)
  return [
    'Blocked: this Bash command is complex enough that Tau should verify the formulation before executing it.',
    '',
    `Reason: ${decision.reasons.join(', ')}`,
    '',
    plan,
    '',
    'To execute after checking the plan or running a discovery command, rerun with syntax_confirmed: true.',
    'If you can express the command as structured command_parts, use that instead of manually quoting raw Bash.',
  ].join('\n')
}

function formatValidationStatus(ok: boolean, message?: string): string[] {
  if (ok) return ['ok']
  const reason = message
    ?.split('\n')
    .find(line => line.trim() && !line.includes('Correction guidance:'))
    ?.trim()
  return ['blocked', ...(reason ? [reason] : [])]
}

function formatNativeParserStatus(analysis: NativeShellAnalysis | null): string[] {
  if (!analysis) return ['- Status: unavailable']
  if (!analysis.ok) {
    const firstDiagnostic = analysis.diagnostics?.[0]
    const location = firstDiagnostic?.line || firstDiagnostic?.column
      ? ` at ${firstDiagnostic.line ?? '?'}:${firstDiagnostic.column ?? '?'}`
      : ''
    return [
      `- Status: parse error from ${analysis.parser}`,
      `- Diagnostic: ${firstDiagnostic ? `${firstDiagnostic.message}${location}` : 'unknown'}`,
    ]
  }

  const summary = analysis.summary
  const firstCommands = Array.isArray(summary?.firstCommands) ? summary.firstCommands : []
  const operators = Array.isArray(summary?.operators) ? summary.operators : []
  const structure = summary
    ? [
        summary.hasCd ? 'cd' : '',
        summary.hasPipeline ? 'pipeline' : '',
        summary.hasRedirect ? 'redirect' : '',
        summary.hasControlFlow ? 'control-flow' : '',
        summary.hasHeredoc ? 'heredoc' : '',
        summary.hasFunction ? 'function' : '',
        summary.hasSubshell ? 'subshell' : '',
        summary.hasCommandSubstitution ? 'command-substitution' : '',
      ].filter(Boolean)
    : []

  return [
    `- Status: ok from ${analysis.parser}`,
    ...(summary ? [`- Commands: ${firstCommands.join(', ') || 'none'} (${summary.commandCount})`] : []),
    ...(summary ? [`- Operators: ${operators.join(', ') || 'none'}`] : []),
    `- Structure: ${structure.join(', ') || 'simple'}`,
    ...(analysis.formatted ? [`- shfmt-style format: ${analysis.formatted}`] : []),
  ]
}

export async function renderBashCommandPlan(
  input: BashCommandPlannerInput,
  cwd = getCwd(),
): Promise<string> {
  const info = analyzeBashCommandPlanning(input)
  const preflight = await validateBashExecutionPreflight(input, cwd)
  const syntax = await validateBashSyntax(input.command)
  const nativeAnalysis = await analyzeNativeShellCommand(input.command)
  const verifiedHelp = info.isDiscoveryCommand ? null : await fetchCommandHelp(input.command)
  let compiledCommandParts: string | null = null
  let compiledCommandPartsError: string | null = null

  if (input.command_parts) {
    try {
      compiledCommandParts = compileBashCommandParts(input.command_parts).command
    } catch (error) {
      compiledCommandPartsError = error instanceof Error ? error.message : String(error)
    }
  }

  const lines: string[] = [
    'Bash command plan (dry run only)',
    '',
    'The command was not executed.',
    '',
    'Command:',
    input.command,
  ]

  if (input.command_parts) {
    lines.push(
      '',
      'Structured command parts:',
    )
    if (compiledCommandParts) {
      lines.push(
        `- Compiled Bash: ${compiledCommandParts}`,
        `- Matches command: ${compiledCommandParts === input.command.trim() ? 'yes' : 'no'}`,
      )
    } else {
      lines.push(`- Compile error: ${compiledCommandPartsError ?? 'unknown'}`)
    }
  }

  lines.push(
    '',
    'Execution context:',
    `- Shell: Bash/POSIX`,
    `- Workdir: ${input.workdir ?? cwd}`,
    `- Background requested: ${input.run_in_background === true ? 'yes' : 'no'}`,
    `- Sandbox override requested: ${input.dangerouslyDisableSandbox === true ? 'yes' : 'no'}`,
    '',
    'Detected shape:',
    `- Domain: ${info.domain}`,
    `- Command key: ${info.key ?? 'none'}`,
    `- Base command: ${info.base ?? 'none'}`,
    `- Subcommand: ${info.subcommand ?? 'none'}`,
    `- Complexity: ${info.complexity.join(', ')}`,
    `- This is already a discovery command: ${info.isDiscoveryCommand ? 'yes' : 'no'}`,
    '',
    'Native shell parser:',
    ...formatNativeParserStatus(nativeAnalysis),
    '',
    'Pre-execution checks:',
    `- Workdir/preflight: ${formatValidationStatus(preflight.ok, preflight.ok ? undefined : preflight.message).join(' - ')}`,
    `- Bash syntax: ${formatValidationStatus(syntax.ok, syntax.ok ? undefined : syntax.message).join(' - ')}`,
  )

  if (info.discoveryCommands.length > 0) {
    lines.push(
      '',
      'Recommended discovery before executing uncertain CLI syntax:',
      ...info.discoveryCommands.map(command => `- ${command}`),
    )
  }

  if (verifiedHelp) {
    const flag = verifiedHelp.entry.source === 'help' ? '--help' : '-h'
    lines.push(
      '',
      `Verified local CLI syntax from ${verifiedHelp.key} ${flag}:`,
      verifiedHelp.entry.content,
    )
  } else if (!info.isDiscoveryCommand && info.key) {
    lines.push(
      '',
      'Verified local CLI syntax:',
      '- Not available from the local binary within the planner timeout/cache.',
    )
  }

  lines.push(
    '',
    'Next step:',
    '- If the plan matches the task, rerun the adjusted command with plan_only omitted or false.',
    '- For commands blocked by proactive planning, set syntax_confirmed to true after checking the plan.',
    '- Actual execution will still pass through Bash syntax validation, permissions, sandboxing, and retry guard.',
    '- If the CLI syntax is still uncertain, run one of the discovery commands first instead of guessing variants.',
  )

  return lines.join('\n')
}
