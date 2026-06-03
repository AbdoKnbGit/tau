import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir, getTeamsDir } from '../envUtils.js'

export type TeamModeNativeTeamContext = {
  teamName: string
  teamFilePath?: string
  leadAgentId?: string
  teammates?: Record<string, {
    name?: string
    agentType?: string
  }>
}

export type TeamModeNativeTaskCounts = {
  total: number
  pending: number
  in_progress: number
  completed: number
}

export type TeamModeNativeStatus = {
  teamName?: string
  hasActiveTeamContext: boolean
  teamFileExists: boolean
  memberCount: number
  activeMemberCount: number
  inboxFileCount: number
  messageCount: number
  unreadMessageCount: number
  taskCounts: TeamModeNativeTaskCounts
}

const EMPTY_TASK_COUNTS: TeamModeNativeTaskCounts = {
  total: 0,
  pending: 0,
  in_progress: 0,
  completed: 0,
}

export function summarizeNativeTeamModeStatus(input: {
  teamContext?: TeamModeNativeTeamContext
  teamName?: string
} = {}): TeamModeNativeStatus {
  const teamName = input.teamContext?.teamName ?? input.teamName
  const base: TeamModeNativeStatus = {
    teamName,
    hasActiveTeamContext: input.teamContext !== undefined,
    teamFileExists: false,
    memberCount: 0,
    activeMemberCount: 0,
    inboxFileCount: 0,
    messageCount: 0,
    unreadMessageCount: 0,
    taskCounts: { ...EMPTY_TASK_COUNTS },
  }

  if (!teamName?.trim()) {
    return base
  }

  const teamFile = readNativeTeamFile(teamName, input.teamContext?.teamFilePath)
  const members = Array.isArray(teamFile?.members) ? teamFile.members : []
  base.teamFileExists = teamFile !== null
  base.memberCount = members.length
  base.activeMemberCount = members.filter(member =>
    isRecord(member) && member.isActive !== false,
  ).length

  const inboxSummary = summarizeInboxes(teamName)
  base.inboxFileCount = inboxSummary.inboxFileCount
  base.messageCount = inboxSummary.messageCount
  base.unreadMessageCount = inboxSummary.unreadMessageCount
  base.taskCounts = summarizeTaskBoard(teamName)
  return base
}

function readNativeTeamFile(
  teamName: string,
  explicitPath?: string,
): Record<string, unknown> | null {
  const candidates = [
    explicitPath,
    join(getTeamsDir(), sanitizeTeamName(teamName), 'config.json'),
  ].filter((path): path is string => typeof path === 'string' && path.length > 0)

  for (const path of candidates) {
    try {
      if (!existsSync(path) || !statSync(path).isFile()) {
        continue
      }
      const parsed = JSON.parse(readFileSync(path, 'utf-8'))
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function summarizeInboxes(teamName: string): {
  inboxFileCount: number
  messageCount: number
  unreadMessageCount: number
} {
  const inboxDir = join(getTeamsDir(), sanitizeTeamName(teamName), 'inboxes')
  let inboxFileCount = 0
  let messageCount = 0
  let unreadMessageCount = 0

  try {
    for (const entry of readdirSync(inboxDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      inboxFileCount++
      const raw = readFileSync(join(inboxDir, entry.name), 'utf-8')
      const messages = JSON.parse(raw)
      if (!Array.isArray(messages)) {
        continue
      }
      messageCount += messages.length
      unreadMessageCount += messages.filter(message =>
        isRecord(message) && message.read !== true,
      ).length
    }
  } catch {
    return { inboxFileCount, messageCount, unreadMessageCount }
  }

  return { inboxFileCount, messageCount, unreadMessageCount }
}

function summarizeTaskBoard(teamName: string): TeamModeNativeTaskCounts {
  const taskDir = join(
    getClaudeConfigHomeDir(),
    'tasks',
    sanitizeTaskListId(teamName),
  )
  const counts: TeamModeNativeTaskCounts = { ...EMPTY_TASK_COUNTS }

  try {
    for (const entry of readdirSync(taskDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue
      }
      const parsed = JSON.parse(readFileSync(join(taskDir, entry.name), 'utf-8'))
      if (!isRecord(parsed) || typeof parsed.status !== 'string') {
        continue
      }
      if (
        parsed.status !== 'pending' &&
        parsed.status !== 'in_progress' &&
        parsed.status !== 'completed'
      ) {
        continue
      }
      counts.total++
      counts[parsed.status]++
    }
  } catch {
    return counts
  }

  return counts
}

function sanitizeTeamName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

function sanitizeTaskListId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
