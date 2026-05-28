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
//
// Descriptions are prescriptive (when to use, what to deliver) rather than
// summary, because they're embedded verbatim into the orchestrator system
// prompt — the LLM treats them as the role's job description.
export const TEAM_MODE_ROLE_META: Record<TeamModeRoleId, TeamModeRoleMeta> = {
  orchestrator: {
    id: 'orchestrator',
    label: 'Orchestrator',
    description:
      'Plans the task end-to-end, decides which workers to spawn and in what order, and synthesizes their outputs into a single user-facing response. Does NOT write code or run shell commands itself — delegates ALL non-trivial work to the appropriate worker. Lives in the main session.',
  },
  architect: {
    id: 'architect',
    label: 'Architect',
    description:
      'Designs the solution BEFORE any code is written. Required for any task touching more than one file, introducing new modules, changing an API, or making non-obvious trade-offs. Deliverable: a written plan listing exact files to change, the change in each, dependencies, and acceptance criteria. Implementer reads this plan; do not skip it on multi-file work.',
  },
  implementer: {
    id: 'implementer',
    label: 'Implementer',
    description:
      'Writes and edits code. Must receive the Architect plan (when one was produced) as part of its prompt. Owns ALL file edits — the Orchestrator never edits files directly. Deliverable: the actual diff plus a one-paragraph summary of what changed and why.',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description:
      'Reads the diff produced by the Implementer for correctness bugs, security issues, dead code, and over-engineering. Required on every multi-file change before the work is reported as done. Deliverable: bullet list of findings — each one actionable, with file:line references. No diff = nothing to review; spawn after Implementer reports completion.',
  },
  verifier: {
    id: 'verifier',
    label: 'Verifier',
    description:
      'Confirms the change actually works by running tests, type-checks, lints, builds, or driving the app. Required whenever code execution behavior changes (logic, build, dependencies). Deliverable: exact commands run, their exit codes, and a verdict: passes / fails with output. Spawn after Implementer; runs in parallel with Reviewer.',
  },
  devops: {
    id: 'devops',
    label: 'DevOps',
    description:
      'Owns CI/CD, deploy configs, containerization, infra-as-code, secrets/env, and pipeline scripts. Spawn ONLY when the task changes one of those surfaces — skip for app-code-only changes. Deliverable: the edited config plus an explanation of pipeline impact.',
  },
  docs: {
    id: 'docs',
    label: 'Docs',
    description:
      'Updates README, CHANGELOG, code comments that document non-obvious WHY, and migration notes. Spawn when public API changes, behavior visibly changes, or the user explicitly asks for docs. Skip for internal-only refactors. Deliverable: edited docs file(s).',
  },
  'dependency-manager': {
    id: 'dependency-manager',
    label: 'Dependency Manager',
    description:
      'Adds, upgrades, removes, or audits npm/pip/cargo/etc. dependencies. Owns lockfile updates and license checks. Spawn ONLY when the task explicitly involves dependency changes; do NOT spawn for unrelated work that happens to touch a lockfile. Deliverable: edited manifest + lockfile + rationale per change.',
  },
  explorer: {
    id: 'explorer',
    label: 'Explorer',
    description:
      'Read-only codebase exploration: locates files, traces call graphs, summarizes how a subsystem works. Spawn at the very start of an unfamiliar task to gather context BEFORE Architect plans. Returns: findings as a structured report — do not have it edit files (it must be a read-only worker).',
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

// Returns the orchestrator role's binding when team-mode is ON, the role is
// configured, AND active. This is what the main session should run as — not
// the user's globally-selected /provider+/model. When null, callers fall
// through to their existing resolution (saved config, env vars, defaults).
//
// Why this exists: the orchestrator role in the roster is the *main session*
// model+provider. Before this helper, /team-mode on only set the addendum
// flag — the main session kept running on whatever /provider and /model the
// user had selected before turning team-mode on. Users configured Orchestrator
// as e.g. "Anthropic / Sonnet 4.6" and were surprised when the orchestrator
// kept running on their previous "OpenRouter / tencent/hy3-preview".
export function getTeamModeOrchestratorBinding(): TeamModeRole | null {
  if (!isTeamModeEnabled()) return null
  const orchestrator = getActiveTeamModeRoles().find(
    r => r.role === 'orchestrator',
  )
  return orchestrator ?? null
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
