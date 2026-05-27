import { getGlobalConfig } from '../config.js'
import { getProviderModelDisplayName } from '../model/display.js'
import {
  isAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../model/providers.js'

// Fixed roster shape — the 8 roles available to /team-mode. Order matters: the
// wizard walks them in this order, and `/team-mode status` lists them this way.
export const TEAM_MODE_ROLE_IDS = [
  'orchestrator',
  'architect',
  'implementer',
  'reviewer',
  'verifier',
  'devops',
  'docs',
  'dependency-manager',
  'explorer',
] as const

export type TeamModeRoleId = (typeof TEAM_MODE_ROLE_IDS)[number]

export type TeamModeRoleMeta = {
  id: TeamModeRoleId
  label: string
  description: string
}

// Human-readable metadata. The orchestrator role is the planner that lives in
// the main session; the others are the workers it can spawn.
export const TEAM_MODE_ROLE_META: Record<TeamModeRoleId, TeamModeRoleMeta> = {
  orchestrator: {
    id: 'orchestrator',
    label: 'Orchestrator',
    description:
      'Plans the task, picks roles, dispatches workers, synthesizes results',
  },
  architect: {
    id: 'architect',
    label: 'Architect',
    description: 'Solution design, system trade-offs, research',
  },
  implementer: {
    id: 'implementer',
    label: 'Implementer',
    description: 'Writes and edits the code',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Reads the diff for correctness, security, simplification',
  },
  verifier: {
    id: 'verifier',
    label: 'Verifier',
    description: 'Tests, validates, checks the implementation actually works',
  },
  devops: {
    id: 'devops',
    label: 'DevOps',
    description: 'Infra, CI, deploy, configuration',
  },
  docs: {
    id: 'docs',
    label: 'Docs',
    description: 'Documentation, README, comments, change notes',
  },
  'dependency-manager': {
    id: 'dependency-manager',
    label: 'Dependency Manager',
    description: 'Package upgrades, dependency audits, lockfile updates',
  },
  explorer: {
    id: 'explorer',
    label: 'Explorer',
    description: 'Read-only codebase exploration and analysis',
  },
}

export type TeamModeRole = {
  role: TeamModeRoleId
  provider: APIProvider
  model: string
  effort?: string | number
  active: boolean
}

function isTeamModeRoleId(value: string): value is TeamModeRoleId {
  return (TEAM_MODE_ROLE_IDS as readonly string[]).includes(value)
}

// Read the persisted roster. Returns one entry per known role, filling in
// blanks for roles the user hasn't configured yet. Unknown role ids in the
// stored config are dropped silently (forward/backward compat).
export function getTeamModeRoles(): TeamModeRole[] {
  const raw = getGlobalConfig().teamModeRoles
  const stored = new Map<TeamModeRoleId, TeamModeRole>()

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (
        !entry ||
        typeof entry.role !== 'string' ||
        !isTeamModeRoleId(entry.role) ||
        typeof entry.provider !== 'string' ||
        !isAPIProvider(entry.provider) ||
        typeof entry.model !== 'string' ||
        !entry.model.trim()
      ) {
        continue
      }
      stored.set(entry.role, {
        role: entry.role,
        provider: entry.provider,
        model: entry.model.trim(),
        effort: entry.effort,
        active: entry.active !== false,
      })
    }
  }

  return TEAM_MODE_ROLE_IDS.map(id => stored.get(id)).filter(
    (entry): entry is TeamModeRole => entry !== undefined,
  )
}

// All roles, including unconfigured ones (returned as null). Used by the
// status renderer and the wizard so the user can see every slot at once.
export function getTeamModeRoleSlots(): Array<{
  meta: TeamModeRoleMeta
  binding: TeamModeRole | null
}> {
  const configured = new Map(getTeamModeRoles().map(r => [r.role, r]))
  return TEAM_MODE_ROLE_IDS.map(id => ({
    meta: TEAM_MODE_ROLE_META[id],
    binding: configured.get(id) ?? null,
  }))
}

export function hasConfiguredTeamModeRoster(): boolean {
  return getTeamModeRoles().length > 0
}

export function isTeamModeEnabled(): boolean {
  return getGlobalConfig().teamModeEnabled === true
}

// Active = configured AND not skipped. The orchestrator only spawns these.
export function getActiveTeamModeRoles(): TeamModeRole[] {
  return getTeamModeRoles().filter(role => role.active)
}

export function formatTeamModeRole(role: TeamModeRole): string {
  const provider = PROVIDER_DISPLAY_NAMES[role.provider]
  const model =
    getProviderModelDisplayName(role.provider, role.model) ?? role.model
  const effort =
    role.effort !== undefined ? `, effort=${String(role.effort)}` : ''
  return `${provider} / ${model}${effort}`
}

// ─── Fallback worker ─────────────────────────────────────────────
//
// When a worker spawn fails with an eligible error and the fallback is
// configured + enabled, AgentTool retries once on this provider+model.
// The shape mirrors a TeamModeRole minus the role/active bookkeeping —
// the fallback isn't a named role, it's a catch-all for any failing role.

export type TeamModeFallbackWorker = {
  provider: APIProvider
  model: string
  effort?: string | number
}

export function getTeamModeFallbackWorker(): TeamModeFallbackWorker | null {
  const raw = getGlobalConfig().teamModeFallbackWorker
  if (
    !raw ||
    typeof raw.provider !== 'string' ||
    !isAPIProvider(raw.provider) ||
    typeof raw.model !== 'string' ||
    !raw.model.trim()
  ) {
    return null
  }
  return {
    provider: raw.provider,
    model: raw.model.trim(),
    effort: raw.effort,
  }
}

export function hasConfiguredTeamModeFallback(): boolean {
  return getTeamModeFallbackWorker() !== null
}

export function isTeamModeFallbackEnabled(): boolean {
  return getGlobalConfig().teamModeFallbackEnabled === true
}

export function formatTeamModeFallback(fb: TeamModeFallbackWorker): string {
  const provider = PROVIDER_DISPLAY_NAMES[fb.provider]
  const model =
    getProviderModelDisplayName(fb.provider, fb.model) ?? fb.model
  const effort =
    fb.effort !== undefined ? `, effort=${String(fb.effort)}` : ''
  return `${provider} / ${model}${effort}`
}
