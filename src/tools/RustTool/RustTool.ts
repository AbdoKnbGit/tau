import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getDisplayPath } from '../../utils/file.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  isNativeRustToolsAvailable,
  runNativeRustTool,
} from '../../utils/nativeRustTools.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { getPowerModeFromSettings } from '../../utils/powerMode.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { RUST_TOOL_ACTIONS, RUST_TOOL_NAME } from './constants.js'

type RustOutput = { text: string }

const pathField = z
  .string()
  .optional()
  .describe(
    'Rust source file, Cargo.toml, or directory. Defaults to the current workspace.',
  )

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(RUST_TOOL_ACTIONS)
      .describe(
        'Rust capability to use. This provider-compatible schema is a flat superset; recognized fields irrelevant to the selected action are ignored.',
      ),
    path: pathField.describe(
      'Workspace/source path for every action except diagnostics. For diagnostics it must be a regular file containing existing rustc/Clippy output, never a workspace directory. test_map requires an existing .rs file.',
    ),
    operation: z
      .enum(['check', 'build', 'clippy', 'test', 'bench', 'doc', 'run'])
      .optional()
      .describe(
        'focused_command only: Cargo operation to plan. Defaults to check when omitted.',
      ),
    features: z
      .array(z.string())
      .max(128)
      .optional()
      .describe('focused_command only: Cargo features to enable.'),
    allFeatures: z
      .boolean()
      .optional()
      .describe('focused_command only: request all Cargo features.'),
    noDefaultFeatures: z
      .boolean()
      .optional()
      .describe('focused_command only: disable default Cargo features.'),
    release: z
      .boolean()
      .optional()
      .describe(
        'Use the release profile for focused_command, artifact_size, or profile_advice. An explicit profile takes precedence.',
      ),
    profile: z
      .string()
      .optional()
      .describe(
        'focused_command, artifact_size, or profile_advice only: Cargo profile name.',
      ),
    targetTriple: z
      .string()
      .optional()
      .describe('focused_command or artifact_size only: Rust target triple.'),
    includeDocTests: z
      .boolean()
      .optional()
      .describe('test_map only: detect fenced Rust doc examples.'),
    input: z
      .string()
      .max(8_388_608)
      .optional()
      .describe(
        'diagnostics only: captured rustc/Clippy JSON-lines or text, parsed through stdin without reading the workspace. Use exactly one of input or path.',
      ),
    maxItems: z
      .number()
      .int()
      .min(1)
      .max(2_000)
      .optional()
      .describe('diagnostics only: maximum deduplicated records.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('artifact_size only: maximum top artifacts.'),
    goal: z
      .enum([
        'balanced',
        'dev_speed',
        'release_size',
        'runtime_performance',
        'compile_time',
      ])
      .optional()
      .describe(
        'profile_advice only: optimization objective. Defaults to balanced when omitted.',
      ),
    maxFiles: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('unsafe_audit only: maximum Rust files to parse.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ text: z.string() }))
type OutputSchema = ReturnType<typeof outputSchema>

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)
}

function formatCommand(value: unknown): string {
  const command = safeRecord(value)
  const program = asString(command.program)
  const args = asArray(command.args).map(asString).filter(Boolean)
  return [program, ...args].filter(Boolean).map(quoteArg).join(' ')
}

function appendWarnings(lines: string[], value: unknown): void {
  const warnings = asArray(value).map(asString).filter(Boolean)
  for (const warning of warnings.slice(0, 8)) lines.push(`Warning: ${warning}`)
  if (warnings.length > 8) lines.push(`Warnings: +${warnings.length - 8} more`)
}

function formatBytes(value: unknown): string {
  const bytes = asNumber(value)
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`
}

export function formatRustWorkspaceContext(json: string): string {
  const context = safeRecord(JSON.parse(json) as unknown)
  const root = asString(context.workspaceRoot)
  const query = asString(context.queryPath)
  const packages = asArray(context.packages).map(safeRecord)
  const selectedPackage = safeRecord(context.selectedPackage)
  const selectedTarget = safeRecord(context.selectedTarget)
  const lines = [
    `Rust workspace: ${getDisplayPath(root || getCwd())} (${packages.length} package${packages.length === 1 ? '' : 's'})`,
  ]
  if (query) lines.push(`Query: ${getDisplayPath(query)}`)
  const packageName = asString(selectedPackage.name)
  if (packageName) {
    const details = [
      `package ${packageName}`,
      asString(selectedPackage.version) &&
        `v${asString(selectedPackage.version)}`,
      asString(selectedPackage.edition) &&
        `edition ${asString(selectedPackage.edition)}`,
      asString(selectedPackage.rustVersion) &&
        `MSRV ${asString(selectedPackage.rustVersion)}`,
      asBoolean(selectedPackage.isDefaultMember) && 'default member',
    ].filter(Boolean)
    lines.push(`Selected: ${details.join(' | ')}`)
  } else {
    lines.push('Selected: no package owns this path')
  }
  if (asString(selectedTarget.name)) {
    const required = asArray(selectedTarget.requiredFeatures)
      .map(asString)
      .filter(Boolean)
    lines.push(
      `Target: ${asString(selectedTarget.kind) || 'unknown'} ${asString(selectedTarget.name)}${required.length ? ` | required features: ${required.join(', ')}` : ''}`,
    )
  }
  const features = Object.keys(safeRecord(selectedPackage.features))
  if (features.length)
    lines.push(
      `Features: ${features.slice(0, 12).join(', ')}${features.length > 12 ? ` +${features.length - 12}` : ''}`,
    )
  if (packages.length > 1) {
    const names = packages.map(value => asString(value.name)).filter(Boolean)
    lines.push(
      `Members: ${names.slice(0, 16).join(', ')}${names.length > 16 ? ` +${names.length - 16}` : ''}`,
    )
  }
  appendWarnings(lines, context.warnings)
  return lines.join('\n')
}

export function formatRustCapability(action: string, json: string): string {
  if (action === 'workspace_context') return formatRustWorkspaceContext(json)
  const report = safeRecord(JSON.parse(json) as unknown)
  const lines: string[] = []
  switch (action) {
    case 'focused_command': {
      lines.push(`Focused Cargo command: ${formatCommand(report)}`)
      if (asString(report.cwd))
        lines.push(`Working directory: ${getDisplayPath(asString(report.cwd))}`)
      if (asString(report.rationale)) lines.push(asString(report.rationale))
      break
    }
    case 'test_map': {
      const tests = asArray(report.tests).map(safeRecord)
      const target = safeRecord(report.target)
      lines.push(
        `Rust test map: ${asString(report.package)} | ${asString(report.scope)} | ${tests.length} declared test${tests.length === 1 ? '' : 's'}`,
      )
      if (asString(target.name))
        lines.push(
          `Harness target: ${asString(target.kind)} ${asString(target.name)}`,
        )
      for (const test of tests.slice(0, 40))
        lines.push(
          `- ${asString(test.name)} (${asString(test.framework)}, line ${asNumber(test.line)})`,
        )
      if (asBoolean(report.hasDocExamples))
        lines.push('Rust doc examples: present')
      break
    }
    case 'diagnostics': {
      const counts = safeRecord(report.counts)
      const diagnostics = asArray(report.diagnostics).map(safeRecord)
      const countText = Object.entries(counts)
        .map(([level, count]) => `${level} ${asNumber(count)}`)
        .join(', ')
      lines.push(
        `Rust diagnostics: ${countText || 'none'}${asNumber(report.omitted) ? ` | ${asNumber(report.omitted)} omitted` : ''}`,
      )
      for (const diagnostic of diagnostics) {
        const span = safeRecord(diagnostic.primarySpan)
        const location = asString(span.file)
          ? `${getDisplayPath(asString(span.file))}:${asNumber(span.lineStart)}:${asNumber(span.columnStart)}`
          : 'no span'
        const code = asString(diagnostic.code)
        const repeats = asNumber(diagnostic.occurrences)
        lines.push(
          `- ${asString(diagnostic.level)}${code ? `[${code}]` : ''} ${location}: ${asString(diagnostic.message)}${repeats > 1 ? ` (x${repeats})` : ''}`,
        )
        for (const suggestion of asArray(diagnostic.suggestions)
          .map(safeRecord)
          .slice(0, 3)) {
          lines.push(
            `  suggestion (${asString(suggestion.applicability) || 'unspecified'}): ${JSON.stringify(asString(suggestion.replacement))}`,
          )
        }
      }
      break
    }
    case 'dependency_cost': {
      const dependencies = asArray(report.directDependencies).map(safeRecord)
      const duplicates = asArray(report.duplicateVersions).map(safeRecord)
      lines.push(
        `Rust dependency cost: ${asString(report.package)} | ${asNumber(report.lockedPackages)} locked packages | ${duplicates.length} duplicate-version crates | ${asNumber(report.gitPackages)} git packages`,
      )
      for (const dependency of dependencies.slice(0, 30)) {
        lines.push(
          `- ${asString(dependency.alias)} -> ${asString(dependency.package)}: ${asNumber(dependency.transitivePackages)} transitive, ${asNumber(dependency.duplicateCrates)} duplicated crates, versions ${asArray(dependency.lockedVersions).map(asString).join(', ') || 'not locked'}`,
        )
      }
      for (const duplicate of duplicates.slice(0, 12))
        lines.push(
          `Duplicate: ${asString(duplicate.package)} ${asArray(duplicate.versions).map(asString).join(', ')}`,
        )
      break
    }
    case 'artifact_size': {
      const artifacts = asArray(report.topArtifacts).map(safeRecord)
      lines.push(
        `Rust artifact size: ${asString(report.profile)} | ${formatBytes(report.totalBytes)} across ${asNumber(report.artifactFiles)} artifacts | incremental ${formatBytes(report.incrementalBytes)}`,
      )
      lines.push(`Target: ${getDisplayPath(asString(report.targetDirectory))}`)
      for (const artifact of artifacts)
        lines.push(
          `- ${formatBytes(artifact.bytes)} ${asString(artifact.category)} ${getDisplayPath(asString(artifact.path))}`,
        )
      for (const variant of asArray(report.duplicateVariants)
        .map(safeRecord)
        .slice(0, 12))
        lines.push(
          `Duplicate variants: ${asString(variant.crateName)} (${asNumber(variant.files)} files, ${formatBytes(variant.bytes)})`,
        )
      break
    }
    case 'profile_advice': {
      const recommendations = asArray(report.recommendations).map(safeRecord)
      lines.push(
        `Rust profile advice: ${asString(report.profile)} for ${asString(report.goal)} | ${recommendations.length} recommendation${recommendations.length === 1 ? '' : 's'}`,
      )
      for (const recommendation of recommendations) {
        lines.push(
          `- ${asString(recommendation.setting)}: ${asString(recommendation.current)} -> ${asString(recommendation.suggested)}; ${asString(recommendation.reason)} Tradeoff: ${asString(recommendation.tradeoff)}`,
        )
      }
      break
    }
    case 'unsafe_audit': {
      const findings = asArray(report.findings).map(safeRecord)
      lines.push(
        `Rust unsafe audit: ${asNumber(report.parsedFiles)}/${asNumber(report.scannedFiles)} files parsed | ${findings.length} findings | ${asNumber(report.undocumentedUnsafe)} undocumented unsafe sites`,
      )
      for (const finding of findings.slice(0, 60)) {
        lines.push(
          `- ${asString(finding.risk)} ${asString(finding.kind)} ${getDisplayPath(asString(finding.file))}:${asNumber(finding.line)}${asString(finding.symbol) ? ` in ${asString(finding.symbol)}` : ''} | safety docs: ${asBoolean(finding.safetyDocumented) ? 'yes' : 'no'}`,
        )
      }
      if (findings.length > 60)
        lines.push(`Findings: +${findings.length - 60} more`)
      break
    }
    default:
      throw new Error(`Unsupported Rust capability output: ${action}`)
  }
  appendWarnings(lines, report.warnings)
  return lines.join('\n')
}

function mapOutput(
  output: RustOutput,
  toolUseID: string,
): ToolResultBlockParam {
  return { tool_use_id: toolUseID, type: 'tool_result', content: output.text }
}

function renderResult(output: RustOutput): React.ReactNode {
  return React.createElement(
    MessageResponse,
    null,
    React.createElement(
      Text,
      null,
      output.text.split(/\r?\n/, 1)[0] || 'Rust analysis',
    ),
  )
}

function displayAction(action: unknown): string {
  return typeof action === 'string' ? action.replaceAll('_', ' ') : 'analysis'
}

export function isRustCapabilityEnabled(): boolean {
  return (
    getPowerModeFromSettings(getInitialSettings()) === 'rust' &&
    isNativeRustToolsAvailable()
  )
}

/**
 * Convert the provider-safe flat schema into one action-specific native call.
 *
 * Providers must see one strict object instead of a discriminated union because
 * some schema sanitizers collapse unions to their first branch. The switch is
 * therefore the action boundary: it deliberately ignores recognized fields
 * owned by another action while Zod continues to reject unknown properties.
 */
export function buildRustNativeInvocation(input: z.output<InputSchema>): {
  command: string
  args: string[]
  stdin?: string
} {
  const path = input.path ?? getCwd()
  switch (input.action) {
    case 'workspace_context':
      return {
        command: 'workspace-context',
        args: ['--path', path, '--pretty'],
      }
    case 'focused_command': {
      const operation = input.operation ?? 'check'
      const args = ['--path', path, '--operation', operation, '--pretty']
      for (const feature of input.features ?? [])
        args.push('--features', feature)
      if (input.allFeatures) args.push('--all-features')
      if (input.noDefaultFeatures) args.push('--no-default-features')
      if (input.profile) args.push('--profile', input.profile)
      else if (input.release) args.push('--release')
      if (input.targetTriple) args.push('--target', input.targetTriple)
      return { command: 'focused-command', args }
    }
    case 'test_map':
      if (!input.path) throw new Error('test_map requires an existing .rs path')
      return {
        command: 'test-map',
        args: [
          '--path',
          input.path,
          '--include-doc-tests',
          String(input.includeDocTests ?? true),
          '--pretty',
        ],
      }
    case 'diagnostics': {
      if ((input.path === undefined) === (input.input === undefined))
        throw new Error('diagnostics requires exactly one of path or input')
      const args = input.path ? ['--file', input.path] : ['--stdin']
      if (input.maxItems) args.push('--max-items', String(input.maxItems))
      args.push('--pretty')
      return { command: 'diagnostics', args, stdin: input.input }
    }
    case 'dependency_cost':
      return { command: 'dependency-cost', args: ['--path', path, '--pretty'] }
    case 'artifact_size': {
      const args = ['--path', path]
      const profile = input.profile ?? (input.release ? 'release' : undefined)
      if (profile) args.push('--profile', profile)
      if (input.targetTriple) args.push('--target', input.targetTriple)
      if (input.limit) args.push('--limit', String(input.limit))
      args.push('--pretty')
      return { command: 'artifact-size', args }
    }
    case 'profile_advice': {
      const goal = input.goal ?? 'balanced'
      const args = ['--path', path, '--goal', goal]
      const profile = input.profile ?? (input.release ? 'release' : undefined)
      if (profile) args.push('--profile', profile)
      args.push('--pretty')
      return { command: 'profile-advice', args }
    }
    case 'unsafe_audit': {
      const args = ['--path', path]
      if (input.maxFiles) args.push('--max-files', String(input.maxFiles))
      args.push('--pretty')
      return { command: 'unsafe-audit', args }
    }
  }
}

export const RustTool = buildTool({
  name: RUST_TOOL_NAME,
  searchHint:
    'rust cargo diagnostics tests dependencies artifacts unsafe profiles',
  shouldDefer: true,
  maxResultSizeChars: 50_000,
  isEnabled: isRustCapabilityEnabled,
  async description() {
    return 'Provide Rust-mode-only Cargo orientation, command planning, and native Rust analysis without execution or edits.'
  },
  async prompt() {
    return `Use this tool only in rustcode mode, and choose one action by ownership:
- workspace_context: Cargo workspace/package/target/features/edition/MSRV orientation. No command planning.
- focused_command: produce exact Cargo argv for check/build/clippy/test/bench/doc/run. It never executes; use Bash for execution. Choose operation explicitly when intent is known; omitted operation conservatively defaults to check.
- test_map: syntax-aware mapping of one .rs file to its harness scope and declared test filters. It never runs tests and does not replace LSP or source search.
- diagnostics: parse output already produced by rustc or Clippy, preserving spans and machine suggestions. It never invokes them or inspects a workspace; use Bash to produce fresh output. Pass captured output as input, or set path to a regular diagnostic-output file. Never pass a workspace/source directory as the diagnostics path.
- dependency_cost: inspect an existing Cargo.lock graph and direct dependency fan-out. It never resolves, fetches, updates, or edits dependencies.
- artifact_size: measure existing target artifacts and incremental storage. It never builds and does not replace a profiler.
- profile_advice: compare actual Cargo profile values with a declared goal and explain tradeoffs. It never edits Cargo.toml and advice must be validated by measurement. Choose goal explicitly when intent is known; omitted goal conservatively defaults to balanced.
- unsafe_audit: parse Rust syntax to inventory unsafe blocks/functions/traits/impls, extern boundaries, exported ABI attributes, and SAFETY documentation. It is not a proof of soundness or a replacement for Miri/security review.

Send only the fields documented for the chosen action. Because every provider receives one flat compatibility schema, recognized fields owned by another action are safely ignored rather than failing the call. Unknown fields remain invalid.

Do not use Rust for general file reading/editing, definitions/references, literal search, arbitrary commands, or command execution; use Read/Edit, LSP, Grep, or Bash. Avoid calling an action when its answer is already known. All actions are stateless and read-only.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  interruptBehavior() {
    return 'cancel'
  },
  userFacingName(input) {
    return `Rust ${displayAction(input?.action)}`
  },
  getPath(input) {
    return expandPath(input.path ?? getCwd())
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    return checkReadPermissionForTool(
      RustTool,
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  renderToolUseMessage(input, { verbose }) {
    const path = input.path ?? getCwd()
    const target =
      input.action === 'diagnostics' && input.input !== undefined
        ? 'captured compiler output'
        : verbose
          ? path
          : getDisplayPath(path)
    return React.createElement(
      Text,
      null,
      `Rust ${displayAction(input.action)} ${target}`,
    )
  },
  renderToolResultMessage: renderResult,
  async call(input, context) {
    if (!RUST_TOOL_ACTIONS.includes(input.action))
      throw new Error(`Unsupported Rust action: ${input.action}`)
    const invocation = buildRustNativeInvocation(input)
    const stdout = await runNativeRustTool(
      invocation.command,
      invocation.args,
      {
        abortSignal: context.abortController.signal,
        timeoutMs:
          input.action === 'unsafe_audit' || input.action === 'artifact_size'
            ? 60_000
            : 30_000,
        maxBuffer: 12_000_000,
        input: invocation.stdin,
      },
    )
    return { data: { text: formatRustCapability(input.action, stdout) } }
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<InputSchema, RustOutput>)

export const RUST_MODE_TOOLS = [RustTool] as const
