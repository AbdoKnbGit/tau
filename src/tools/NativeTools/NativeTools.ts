import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getDisplayPath } from '../../utils/file.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  isNativeTauToolsAvailable,
  runNativeTauTool,
} from '../../utils/nativeTauTools.js'
import {
  NATIVE_GIT_SUMMARY_TOOL_NAME,
  NATIVE_SYSINFO_TOOL_NAME,
} from './constants.js'

type NativeOutput = {
  text: string
}

const outputSchema = lazySchema(() =>
  z.object({
    text: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

const gitSummaryInputSchema = lazySchema(() =>
  z.strictObject({
    repo: z
      .string()
      .optional()
      .describe('Repository path. Defaults to the current workspace.'),
    commits: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe('Number of recent commits to include. Default: 8.'),
    status: z
      .boolean()
      .optional()
      .describe('Include worktree status. Default: true.'),
  }),
)
type GitSummaryInputSchema = ReturnType<typeof gitSummaryInputSchema>

const sysinfoInputSchema = lazySchema(() => z.strictObject({}))
type SysinfoInputSchema = ReturnType<typeof sysinfoInputSchema>

function mapOutput(output: NativeOutput, toolUseID: string): ToolResultBlockParam {
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: output.text,
  }
}

function renderToolResultMessage(output: NativeOutput): React.ReactNode {
  const firstLine = output.text.split(/\r?\n/, 1)[0] || 'Native helper result'
  return React.createElement(
    MessageResponse,
    null,
    React.createElement(Text, null, firstLine),
  )
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstLine(value: unknown): string {
  return asString(value).trim().split(/\r?\n/, 1)[0] ?? ''
}

function statusPath(entry: unknown): string {
  const record = safeRecord(entry)
  return asString(record.path)
}

function statusKind(entry: unknown): string {
  const record = safeRecord(entry)
  const staging = asString(record.staging).trim()
  const worktree = asString(record.worktree).trim()
  const code = worktree || staging || '?'
  switch (code[0]) {
    case '?':
      return 'untracked'
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'unmerged'
    default:
      return 'changed'
  }
}

function countByKind(items: unknown[]): Map<string, unknown[]> {
  const groups = new Map<string, unknown[]>()
  for (const item of items) {
    const kind = statusKind(item)
    const existing = groups.get(kind)
    if (existing) {
      existing.push(item)
    } else {
      groups.set(kind, [item])
    }
  }
  return groups
}

function formatPathList(items: unknown[], limit = 4): string {
  const paths = items.map(statusPath).filter(Boolean)
  if (paths.length === 0) return 'unknown paths'
  const shown = paths.slice(0, limit).join(', ')
  return `${shown}${paths.length > limit ? ` +${paths.length - limit}` : ''}`
}

function compactText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function formatGitSummary(json: string): string {
  const data = safeRecord(JSON.parse(json) as unknown)
  const lines: string[] = []
  const repo = asString(data.repository) || getCwd()

  const head = safeRecord(data.head)
  const branch = asString(head.branch)
  const short = asString(head.short)
  const message = compactText(firstLine(head.message), 72)
  lines.push(
    `Git: ${getDisplayPath(repo)}${branch || short ? ` | ${branch || 'detached'}${short ? ` @ ${short}` : ''}` : ''}${message ? ` - ${message}` : ''}`,
  )

  const status = asArray(data.status)
  if (status.length > 0) {
    const groups = countByKind(status)
    const summary = [...groups.entries()]
      .map(([kind, items]) => `${items.length} ${kind}`)
      .join(', ')
    lines.push(`Changes: ${status.length} file${status.length === 1 ? '' : 's'} (${summary})`)
    for (const [kind, items] of [...groups.entries()].slice(0, 4)) {
      lines.push(`${kind}: ${formatPathList(items)}`)
    }
  } else {
    lines.push('Changes: clean')
  }

  const branches = asArray(data.branches).map(asString).filter(Boolean)
  const otherBranches = branches.filter(name => name !== branch)
  if (otherBranches.length > 0) {
    lines.push(
      `Branches: ${[branch, ...otherBranches].filter(Boolean).slice(0, 6).join(', ')}${branches.length > 6 ? ` +${branches.length - 6}` : ''}`,
    )
  }

  const recent = asArray(data.recent)
  if (recent.length > 0) {
    const commits = recent.slice(0, 3).map(commit => {
      const record = safeRecord(commit)
      const commitShort = asString(record.short)
      const commitMessage = compactText(firstLine(record.message), 64)
      return `${commitShort}${commitMessage ? ` ${commitMessage}` : ''}`
    })
    lines.push(`Recent: ${commits.join(' | ')}`)
  }

  return lines.join('\n')
}

function formatBytes(value: unknown): string {
  const n = asNumber(value)
  if (n === null) return 'unknown'
  const gib = n / 1024 / 1024 / 1024
  return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`
}

function formatPercent(value: unknown): string {
  const n = asNumber(value)
  return n === null ? 'unknown' : `${n.toFixed(1)}%`
}

function formatSysinfo(json: string): string {
  const data = safeRecord(JSON.parse(json) as unknown)
  const runtime = safeRecord(data.runtime)
  const host = safeRecord(data.host)
  const memory = safeRecord(data.memory)
  const swap = safeRecord(data.swap)
  const load = safeRecord(data.load)
  const processes = safeRecord(data.processes)
  const cpu = asArray(data.cpu).map(safeRecord)
  const cpuUsage = asArray(data.cpuUsagePercent).map(asNumber).filter((n): n is number => n !== null)
  const disks = asArray(data.disk).map(safeRecord)

  const lines: string[] = []
  const logicalCores = asNumber(runtime.numCPU) ?? (cpu.length || null)
  const platform =
    asString(data.platform) || `${asString(runtime.goos)}/${asString(runtime.goarch)}`
  const os = [host.os, host.platform, host.platformVersion]
    .map(asString)
    .filter(Boolean)
    .join(' ')
  lines.push(
    `System: ${os || platform}${logicalCores ? ` | ${logicalCores} cores` : ''}`,
  )

  const loadParts: string[] = []
  if (cpuUsage.length > 0) {
    const avg = cpuUsage.reduce((sum, n) => sum + n, 0) / cpuUsage.length
    loadParts.push(`CPU ${avg.toFixed(1)}%`)
  }
  if (Object.keys(memory).length > 0) {
    loadParts.push(
      `mem ${formatBytes(memory.used)}/${formatBytes(memory.total)} (${formatPercent(memory.usedPercent)})`,
    )
  }
  if (Object.keys(swap).length > 0 && asNumber(swap.total)) {
    loadParts.push(
      `swap ${formatBytes(swap.used)}/${formatBytes(swap.total)} (${formatPercent(swap.usedPercent)})`,
    )
  }
  if (Object.keys(load).length > 0) {
    loadParts.push(
      `load ${asNumber(load.load1)?.toFixed(2) ?? 'n/a'}/${asNumber(load.load5)?.toFixed(2) ?? 'n/a'}/${asNumber(load.load15)?.toFixed(2) ?? 'n/a'}`,
    )
  }
  if (loadParts.length > 0) {
    lines.push(`Load: ${loadParts.join(' | ')}`)
  }

  const usableDisks = disks.filter(disk => asNumber(disk.total))
  if (usableDisks.length > 0) {
    const diskText = usableDisks
      .slice(0, 3)
      .map(
        disk =>
          `${asString(disk.mountpoint) || '?'} ${formatBytes(disk.used)}/${formatBytes(disk.total)} (${formatPercent(disk.usedPercent)})`,
      )
      .join(' | ')
    lines.push(
      `Disk: ${diskText}${usableDisks.length > 3 ? ` | +${usableDisks.length - 3}` : ''}`,
    )
  }
  lines.push(`Processes: ${asNumber(processes.count) ?? 'unknown'}`)

  return lines.join('\n')
}

function nativeUnavailableText(error: unknown): string {
  return error instanceof Error
    ? `Native Tau helper unavailable: ${error.message}`
    : 'Native Tau helper unavailable.'
}

export const NativeGitSummaryTool = buildTool({
  name: NATIVE_GIT_SUMMARY_TOOL_NAME,
  searchHint: 'read git branch commits status',
  shouldDefer: true,
  maxResultSizeChars: 20_000,
  isEnabled: isNativeTauToolsAvailable,
  async description() {
    return 'Return a concise read-only Git repository summary using Tau native go-git integration.'
  },
  async prompt() {
    return 'Use for read-only Git context: current branch, HEAD, recent commits, and worktree status. Return the concise formatted summary, not raw JSON.'
  },
  get inputSchema(): GitSummaryInputSchema {
    return gitSummaryInputSchema()
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
  userFacingName() {
    return 'Git Summary'
  },
  getPath(input) {
    return expandPath(input.repo ?? getCwd())
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    return checkReadPermissionForTool(
      NativeGitSummaryTool,
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  renderToolUseMessage(input, { verbose }) {
    const repo = input.repo ?? getCwd()
    return `Git summary ${verbose ? repo : getDisplayPath(repo)}`
  },
  renderToolResultMessage,
  async call(input) {
    try {
      const args = ['--repo', input.repo ?? getCwd(), '--pretty']
      if (input.commits !== undefined) args.push('--commits', String(input.commits))
      if (input.status === false) args.push('--status=false')
      const stdout = await runNativeTauTool('git-summary', args)
      return { data: { text: formatGitSummary(stdout) } }
    } catch (error) {
      return { data: { text: nativeUnavailableText(error) } }
    }
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<GitSummaryInputSchema, NativeOutput>)

export const NativeSysInfoTool = buildTool({
  name: NATIVE_SYSINFO_TOOL_NAME,
  searchHint: 'read local cpu memory disk load',
  shouldDefer: true,
  maxResultSizeChars: 20_000,
  isEnabled: isNativeTauToolsAvailable,
  async description() {
    return 'Return a concise sanitized local system/resource summary using Tau native gopsutil integration.'
  },
  async prompt() {
    return 'Use when local resource context matters, especially CPU, memory, disk, load, or process count. Return the concise formatted summary, not raw JSON.'
  },
  get inputSchema(): SysinfoInputSchema {
    return sysinfoInputSchema()
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
  userFacingName() {
    return 'Sysinfo'
  },
  renderToolUseMessage() {
    return 'System resource summary'
  },
  renderToolResultMessage,
  async call() {
    try {
      const stdout = await runNativeTauTool('sysinfo', ['--pretty'])
      return { data: { text: formatSysinfo(stdout) } }
    } catch (error) {
      return { data: { text: nativeUnavailableText(error) } }
    }
  },
  mapToolResultToToolResultBlockParam: mapOutput,
} satisfies ToolDef<SysinfoInputSchema, NativeOutput>)

export const NATIVE_READ_ONLY_TOOLS = [
  NativeGitSummaryTool,
  NativeSysInfoTool,
] as const
