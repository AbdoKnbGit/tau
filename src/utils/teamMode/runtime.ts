import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import type { TeamModeFallbackWorker, TeamModeRole } from './state.js'

export const TEAM_MODE_RUNTIME_SCHEMA_VERSION = 1 as const

const MAX_RUNS = 200
const MAX_MISSION_LOG_ENTRIES = 300
const MAX_OUTCOMES = 200
const MAX_TEXT_LENGTH = 1_200

export type TeamModeRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type TeamModeRuntimeRole = {
  role: string
  provider: string
  model: string
  effort?: string | number
  active: boolean
}

export type TeamModeRuntimeFallback = {
  enabled: boolean
  provider?: string
  model?: string
  effort?: string | number
}

export type TeamModeRunRecord = {
  id: string
  role: string
  provider: string
  model: string
  teamName?: string
  description?: string
  promptPreview?: string
  runInBackground?: boolean
  status: TeamModeRunStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  error?: string
  resultPreview?: string
}

export type TeamModeMissionLogEntry = {
  id: string
  at: string
  level: 'info' | 'warn' | 'error'
  event: string
  runId?: string
  role?: string
  detail?: string
}

export type TeamModeOutcomeRecord = {
  runId: string
  role: string
  status: Extract<
    TeamModeRunStatus,
    'completed' | 'failed' | 'cancelled' | 'interrupted'
  >
  at: string
  summary?: string
}

export type TeamModeRuntimeState = {
  schemaVersion: typeof TEAM_MODE_RUNTIME_SCHEMA_VERSION
  runtimeId: string
  teamName: string
  createdAt: string
  updatedAt: string
  enabled: boolean
  roles: TeamModeRuntimeRole[]
  fallback: TeamModeRuntimeFallback
  runs: TeamModeRunRecord[]
  missionLog: TeamModeMissionLogEntry[]
  outcomes: TeamModeOutcomeRecord[]
}

export type TeamModeRuntimeSummary = {
  exists: boolean
  enabled: boolean
  runtimeId?: string
  teamName?: string
  updatedAt?: string
  roleCount: number
  activeRoleCount: number
  fallbackEnabled: boolean
  runCounts: Record<TeamModeRunStatus, number>
  latestRun?: TeamModeRunRecord
  latestLog?: TeamModeMissionLogEntry
}

export type TeamModeRuntimeConfigInput = {
  roles?: TeamModeRole[]
  fallback?: TeamModeFallbackWorker | null
  fallbackEnabled?: boolean
  enabled?: boolean
  event?: string
  teamName?: string
}

export type TeamModeRunStartInput = {
  role: string
  provider: string
  model: string
  teamName?: string
  description?: string
  prompt?: string
  runInBackground?: boolean
}

export type TeamModeRunFinishInput = {
  resultPreview?: string
  status?: Extract<TeamModeRunStatus, 'completed' | 'cancelled' | 'interrupted'>
}

const EMPTY_RUN_COUNTS: Record<TeamModeRunStatus, number> = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
}

export function getTeamModeRuntimeDir(): string {
  return join(getClaudeConfigHomeDir(), 'team-mode')
}

export function getTeamModeRuntimePath(): string {
  return join(getTeamModeRuntimeDir(), 'current.json')
}

export function readTeamModeRuntimeState(): TeamModeRuntimeState | null {
  const path = getTeamModeRuntimePath()

  try {
    if (!existsSync(path)) {
      return null
    }
    const raw = readFileSync(path, { encoding: 'utf-8' })
    return normalizeRuntimeState(JSON.parse(raw))
  } catch (error) {
    logRuntimeFailure('read', error)
    return null
  }
}

export function syncTeamModeRuntimeConfig(
  input: TeamModeRuntimeConfigInput,
): TeamModeRuntimeState | null {
  return updateRuntimeState(state => {
    const now = new Date().toISOString()
    const next =
      state ??
      createRuntimeState({
        enabled: input.enabled,
        teamName: input.teamName,
        roles: input.roles,
        fallback: input.fallback,
        fallbackEnabled: input.fallbackEnabled,
      })

    next.updatedAt = now
    if (input.teamName !== undefined && input.teamName.trim()) {
      next.teamName = sanitizeShortText(input.teamName)
    }
    if (input.enabled !== undefined) {
      next.enabled = input.enabled
    }
    if (input.roles !== undefined) {
      next.roles = normalizeRoles(input.roles)
    }
    if (
      input.fallback !== undefined ||
      input.fallbackEnabled !== undefined
    ) {
      next.fallback = normalizeFallback(
        input.fallback,
        input.fallbackEnabled,
        next.fallback,
      )
    }
    if (input.event) {
      appendMissionLog(next, {
        level: 'info',
        event: input.event,
      })
    }
    trimRuntimeState(next)
    return next
  })
}

export function setTeamModeRuntimeEnabled(
  input: Omit<TeamModeRuntimeConfigInput, 'enabled'> & { enabled: boolean },
): TeamModeRuntimeState | null {
  return syncTeamModeRuntimeConfig({
    ...input,
    event: input.event ?? (input.enabled ? 'team-mode enabled' : 'team-mode disabled'),
  })
}

export function clearTeamModeRuntimeState(): void {
  try {
    rmSync(getTeamModeRuntimePath(), { force: true })
  } catch (error) {
    logRuntimeFailure('clear', error)
  }
}

export function startTeamModeRun(
  input: TeamModeRunStartInput,
): TeamModeRunRecord | null {
  let created: TeamModeRunRecord | null = null
  updateRuntimeState(state => {
    const now = new Date().toISOString()
    const next = state ?? createRuntimeState({ enabled: true })
    next.enabled = true
    next.updatedAt = now
    const record: TeamModeRunRecord = {
      id: newRuntimeId('tmrun'),
      role: sanitizeShortText(input.role || 'unknown'),
      provider: sanitizeShortText(input.provider),
      model: sanitizeShortText(input.model),
      teamName: input.teamName
        ? sanitizeShortText(input.teamName)
        : undefined,
      description: input.description
        ? truncateText(input.description)
        : undefined,
      promptPreview: input.prompt ? truncateText(input.prompt) : undefined,
      runInBackground: input.runInBackground,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    created = record
    next.runs.push(record)
    appendMissionLog(next, {
      level: 'info',
      event: 'worker run started',
      runId: record.id,
      role: record.role,
      detail: `${record.provider}/${record.model}`,
    })
    trimRuntimeState(next)
    return next
  })
  return created
}

export function completeTeamModeRun(
  runId: string,
  input: TeamModeRunFinishInput = {},
): void {
  const status = input.status ?? 'completed'
  updateExistingRun(runId, run => {
    const now = new Date().toISOString()
    run.status = status
    run.completedAt = now
    run.updatedAt = now
    if (input.resultPreview) {
      run.resultPreview = truncateText(input.resultPreview)
    }
    return {
      level: 'info',
      event: `worker run ${status}`,
      detail: run.resultPreview,
    }
  })
}

export function failTeamModeRun(runId: string, error: unknown): void {
  updateExistingRun(runId, run => {
    const now = new Date().toISOString()
    run.status = 'failed'
    run.completedAt = now
    run.updatedAt = now
    run.error = truncateText(errorMessage(error))
    return {
      level: 'error',
      event: 'worker run failed',
      detail: run.error,
    }
  })
}

export function summarizeTeamModeRuntime(
  state: TeamModeRuntimeState | null = readTeamModeRuntimeState(),
): TeamModeRuntimeSummary {
  if (state === null) {
    return {
      exists: false,
      enabled: false,
      roleCount: 0,
      activeRoleCount: 0,
      fallbackEnabled: false,
      runCounts: { ...EMPTY_RUN_COUNTS },
    }
  }

  const runCounts = { ...EMPTY_RUN_COUNTS }
  for (const run of state.runs) {
    runCounts[run.status]++
  }

  return {
    exists: true,
    enabled: state.enabled,
    runtimeId: state.runtimeId,
    teamName: state.teamName,
    updatedAt: state.updatedAt,
    roleCount: state.roles.length,
    activeRoleCount: state.roles.filter(role => role.active).length,
    fallbackEnabled: state.fallback.enabled,
    runCounts,
    latestRun: state.runs.at(-1),
    latestLog: state.missionLog.at(-1),
  }
}

function updateExistingRun(
  runId: string,
  update: (run: TeamModeRunRecord) => {
    level: TeamModeMissionLogEntry['level']
    event: string
    detail?: string
  },
): void {
  updateRuntimeState(state => {
    if (state === null) {
      return null
    }
    const run = state.runs.find(candidate => candidate.id === runId)
    if (!run) {
      return state
    }
    const log = update(run)
    state.updatedAt = run.updatedAt
    appendMissionLog(state, {
      ...log,
      runId,
      role: run.role,
    })
    if (run.status !== 'running' && run.status !== 'queued') {
      state.outcomes.push({
        runId,
        role: run.role,
        status: run.status,
        at: run.completedAt ?? run.updatedAt,
        summary: run.resultPreview ?? run.error,
      })
    }
    trimRuntimeState(state)
    return state
  })
}

function updateRuntimeState(
  update: (
    state: TeamModeRuntimeState | null,
  ) => TeamModeRuntimeState | null,
): TeamModeRuntimeState | null {
  try {
    const next = update(readTeamModeRuntimeState())
    if (next === null) {
      return null
    }
    writeTeamModeRuntimeState(next)
    return next
  } catch (error) {
    logRuntimeFailure('update', error)
    return null
  }
}

function writeTeamModeRuntimeState(state: TeamModeRuntimeState): void {
  mkdirSync(getTeamModeRuntimeDir(), { recursive: true, mode: 0o700 })
  writeFileSync(
    getTeamModeRuntimePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    {
      encoding: 'utf-8',
    },
  )
}

function createRuntimeState(
  input: {
    enabled?: boolean
    teamName?: string
    roles?: TeamModeRole[]
    fallback?: TeamModeFallbackWorker | null
    fallbackEnabled?: boolean
  } = {},
): TeamModeRuntimeState {
  const now = new Date().toISOString()
  return {
    schemaVersion: TEAM_MODE_RUNTIME_SCHEMA_VERSION,
    runtimeId: newRuntimeId('tmrt'),
    teamName: input.teamName?.trim()
      ? sanitizeShortText(input.teamName)
      : 'team-mode',
    createdAt: now,
    updatedAt: now,
    enabled: input.enabled === true,
    roles: normalizeRoles(input.roles ?? []),
    fallback: normalizeFallback(
      input.fallback,
      input.fallbackEnabled,
      { enabled: false },
    ),
    runs: [],
    missionLog: [],
    outcomes: [],
  }
}

function normalizeRuntimeState(raw: unknown): TeamModeRuntimeState | null {
  if (!isRecord(raw)) {
    return null
  }
  const now = new Date().toISOString()
  return {
    schemaVersion: TEAM_MODE_RUNTIME_SCHEMA_VERSION,
    runtimeId:
      typeof raw.runtimeId === 'string' && raw.runtimeId.trim()
        ? sanitizeShortText(raw.runtimeId)
        : newRuntimeId('tmrt'),
    teamName:
      typeof raw.teamName === 'string' && raw.teamName.trim()
        ? sanitizeShortText(raw.teamName)
        : 'team-mode',
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt.trim()
        ? raw.createdAt
        : now,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
        ? raw.updatedAt
        : now,
    enabled: raw.enabled === true,
    roles: Array.isArray(raw.roles)
      ? raw.roles.flatMap(normalizeRuntimeRole)
      : [],
    fallback: normalizeRuntimeFallback(raw.fallback),
    runs: Array.isArray(raw.runs)
      ? raw.runs.flatMap(normalizeRunRecord).slice(-MAX_RUNS)
      : [],
    missionLog: Array.isArray(raw.missionLog)
      ? raw.missionLog
          .flatMap(normalizeMissionLogEntry)
          .slice(-MAX_MISSION_LOG_ENTRIES)
      : [],
    outcomes: Array.isArray(raw.outcomes)
      ? raw.outcomes.flatMap(normalizeOutcomeRecord).slice(-MAX_OUTCOMES)
      : [],
  }
}

function normalizeRoles(roles: TeamModeRole[]): TeamModeRuntimeRole[] {
  return roles.map(role => ({
    role: role.role,
    provider: role.provider,
    model: sanitizeShortText(role.model),
    effort: role.effort,
    active: role.active,
  }))
}

function normalizeRuntimeRole(raw: unknown): TeamModeRuntimeRole[] {
  if (
    !isRecord(raw) ||
    typeof raw.role !== 'string' ||
    typeof raw.provider !== 'string' ||
    typeof raw.model !== 'string' ||
    !raw.role.trim() ||
    !raw.provider.trim() ||
    !raw.model.trim()
  ) {
    return []
  }
  return [{
    role: raw.role,
    provider: raw.provider,
    model: sanitizeShortText(raw.model),
    effort: normalizeEffort(raw.effort),
    active: raw.active !== false,
  }]
}

function normalizeFallback(
  fallback: TeamModeFallbackWorker | null | undefined,
  fallbackEnabled: boolean | undefined,
  previous: TeamModeRuntimeFallback,
): TeamModeRuntimeFallback {
  if (fallback === undefined) {
    return {
      ...previous,
      enabled: fallbackEnabled ?? previous.enabled,
    }
  }
  if (fallback === null) {
    return { enabled: false }
  }
  return {
    enabled: fallbackEnabled ?? true,
    provider: fallback.provider,
    model: sanitizeShortText(fallback.model),
    effort: fallback.effort,
  }
}

function normalizeRuntimeFallback(raw: unknown): TeamModeRuntimeFallback {
  if (!isRecord(raw)) {
    return { enabled: false }
  }
  if (
    typeof raw.provider === 'string' &&
    raw.provider.trim() &&
    typeof raw.model === 'string' &&
    raw.model.trim()
  ) {
    return {
      enabled: raw.enabled === true,
      provider: raw.provider,
      model: sanitizeShortText(raw.model),
      effort: normalizeEffort(raw.effort),
    }
  }
  return { enabled: raw.enabled === true }
}

function normalizeRunRecord(raw: unknown): TeamModeRunRecord[] {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.role !== 'string' ||
    typeof raw.provider !== 'string' ||
    typeof raw.model !== 'string' ||
    !isRunStatus(raw.status) ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.updatedAt !== 'string'
  ) {
    return []
  }

  return [{
    id: sanitizeShortText(raw.id),
    role: sanitizeShortText(raw.role),
    provider: sanitizeShortText(raw.provider),
    model: sanitizeShortText(raw.model),
    teamName:
      typeof raw.teamName === 'string'
        ? sanitizeShortText(raw.teamName)
        : undefined,
    description:
      typeof raw.description === 'string'
        ? truncateText(raw.description)
        : undefined,
    promptPreview:
      typeof raw.promptPreview === 'string'
        ? truncateText(raw.promptPreview)
        : undefined,
    runInBackground:
      typeof raw.runInBackground === 'boolean'
        ? raw.runInBackground
        : undefined,
    status: raw.status,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    completedAt:
      typeof raw.completedAt === 'string' ? raw.completedAt : undefined,
    error:
      typeof raw.error === 'string' ? truncateText(raw.error) : undefined,
    resultPreview:
      typeof raw.resultPreview === 'string'
        ? truncateText(raw.resultPreview)
        : undefined,
  }]
}

function normalizeMissionLogEntry(raw: unknown): TeamModeMissionLogEntry[] {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    typeof raw.at !== 'string' ||
    !isMissionLogLevel(raw.level) ||
    typeof raw.event !== 'string'
  ) {
    return []
  }
  return [{
    id: sanitizeShortText(raw.id),
    at: raw.at,
    level: raw.level,
    event: sanitizeShortText(raw.event),
    runId:
      typeof raw.runId === 'string' ? sanitizeShortText(raw.runId) : undefined,
    role:
      typeof raw.role === 'string' ? sanitizeShortText(raw.role) : undefined,
    detail:
      typeof raw.detail === 'string' ? truncateText(raw.detail) : undefined,
  }]
}

function normalizeOutcomeRecord(raw: unknown): TeamModeOutcomeRecord[] {
  if (
    !isRecord(raw) ||
    typeof raw.runId !== 'string' ||
    typeof raw.role !== 'string' ||
    !isFinishedRunStatus(raw.status) ||
    typeof raw.at !== 'string'
  ) {
    return []
  }
  return [{
    runId: sanitizeShortText(raw.runId),
    role: sanitizeShortText(raw.role),
    status: raw.status,
    at: raw.at,
    summary:
      typeof raw.summary === 'string' ? truncateText(raw.summary) : undefined,
  }]
}

function appendMissionLog(
  state: TeamModeRuntimeState,
  entry: Omit<TeamModeMissionLogEntry, 'id' | 'at'>,
): void {
  state.missionLog.push({
    id: newRuntimeId('tmlog'),
    at: new Date().toISOString(),
    ...entry,
    detail: entry.detail ? truncateText(entry.detail) : undefined,
  })
}

function trimRuntimeState(state: TeamModeRuntimeState): void {
  state.runs = state.runs.slice(-MAX_RUNS)
  state.missionLog = state.missionLog.slice(-MAX_MISSION_LOG_ENTRIES)
  state.outcomes = state.outcomes.slice(-MAX_OUTCOMES)
}

function newRuntimeId(prefix: string): string {
  try {
    return `${prefix}_${randomUUID()}`
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 10)}`
  }
}

function truncateText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_TEXT_LENGTH - 3)}...`
    : normalized
}

function sanitizeShortText(value: string): string {
  return truncateText(value).slice(0, 240)
}

function normalizeEffort(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined
}

function isRunStatus(value: unknown): value is TeamModeRunStatus {
  return (
    value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'interrupted'
  )
}

function isFinishedRunStatus(
  value: unknown,
): value is TeamModeOutcomeRecord['status'] {
  return (
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled' ||
    value === 'interrupted'
  )
}

function isMissionLogLevel(
  value: unknown,
): value is TeamModeMissionLogEntry['level'] {
  return value === 'info' || value === 'warn' || value === 'error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function logRuntimeFailure(action: string, error: unknown): void {
  // Runtime bookkeeping should never break team-mode execution. Keep this
  // local and dependency-light so tests and worker spawns do not pull in the
  // broader bootstrap/debug stack.
  void action
  void error
}
