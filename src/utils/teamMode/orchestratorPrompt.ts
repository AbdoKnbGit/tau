/**
 * Team-mode orchestrator prompt.
 *
 * Composes the addendum injected into the main session's system prompt when
 * /team-mode is ON. The string is purely a function of the active roster, so
 * within a stable session it's bit-identical across turns — the provider
 * prompt cache stays warm.
 *
 * Returns null when:
 *   - team-mode is OFF, OR
 *   - the roster has no active roles to spawn
 *
 * In both cases the system prompt is byte-identical to its pre-team-mode form.
 * That's the cache-preservation contract: normal mode pays nothing.
 */

import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { PROVIDER_DISPLAY_NAMES } from '../model/providers.js'
import {
  formatTeamModeFallback,
  getActiveTeamModeRoles,
  getTeamModeFallbackWorker,
  isTeamModeEnabled,
  isTeamModeFallbackEnabled,
  TEAM_MODE_ROLE_META,
} from './state.js'

export function getTeamModeOrchestratorAddendum(): string | null {
  if (!isTeamModeEnabled()) return null
  const roles = getActiveTeamModeRoles()
  if (roles.length === 0) return null

  // Sorted by role id (stable order from TEAM_MODE_ROLE_IDS) so identical
  // rosters produce identical strings across sessions and turns. Don't sort
  // by display label — that's the same in practice but ordering by id makes
  // the contract explicit.
  const rosterLines = roles.map(role => {
    const meta = TEAM_MODE_ROLE_META[role.role]
    const provider = PROVIDER_DISPLAY_NAMES[role.provider]
    return `- ${meta.label} (${role.role}): ${provider} / ${role.model} — ${meta.description}`
  })

  const swarmSection = isAgentSwarmsEnabled()
    ? [
        '',
        '## Direct worker-to-worker coordination (swarms enabled)',
        '',
        'Because agent swarms are enabled in this session, you can let workers talk to each other instead of routing every message through you. The pattern:',
        '',
        '1. `TeamCreate({team_name: "task-<short-id>"})` once at the start of orchestration.',
        '2. Spawn each worker with both `team_name` (the team you just created) AND `name` (use the role id, e.g. `"architect"`, `"implementer"`). This makes them addressable.',
        '3. Workers can `SendMessage({to: "<role-id>", message: "...", summary: "..."})` to ask each other questions or hand off context directly.',
        '4. When the team is done, `TeamDelete` cleans up.',
        '',
        'Use this for tasks where workers need real-time context from each other (e.g. reviewer asks implementer about a specific decision). Skip it for fully independent parallel work — plain `Agent({...})` calls are lighter.',
      ]
    : []

  return [
    '# Team Mode (Auto-Orchestration)',
    '',
    'You are operating with /team-mode ON. The user has bound a fixed roster of specialized roles to specific provider+model pairs:',
    '',
    ...rosterLines,
    '',
    '## How to use the team',
    '',
    'For non-trivial work, decompose the task into parallel-safe phases and spawn the right role(s) via the Agent tool. Each spawned worker runs through its bound provider and model — you do NOT need to switch your own provider.',
    '',
    'Spawn syntax (always include `provider` and `model_id` from the roster above):',
    '',
    '```',
    'Agent({',
    '  subagent_type: "general-purpose",',
    '  description: "<3-5 word phase title>",',
    '  prompt: "<task for this worker — give them full context and a concrete deliverable>",',
    '  provider: "<role\'s provider, e.g. kiro>",',
    '  model_id: "<role\'s model, e.g. claude-sonnet-4-5>"',
    '})',
    '```',
    '',
    'Spawn multiple agents in the SAME tool-call message when their work is independent — that gives you true parallelism across providers.',
    '',
    '## When to skip orchestration',
    '',
    'If the task is genuinely single-step (one file edit, one shell command, a direct factual question, a quick clarification), just do the work yourself. The team is for actual decomposable work — there is no benefit to spawning a worker for a one-line change.',
    '',
    '## Conflict prevention',
    '',
    'Two workers must not edit the same file in the same wave. If two roles need the same file, run them sequentially: spawn one, wait for the result, then spawn the next with the updated file context.',
    '',
    '## Synthesis',
    '',
    'After workers complete, summarize their outputs into a single coherent response for the user. Quote relevant file paths and decisions; do not paste large blobs of worker output verbatim.',
    '',
    '## Missing roles',
    '',
    'The roster above lists only the roles the user has configured. If your task needs a role that is NOT in the roster (e.g. you need a Verifier but no Verifier is bound), pick the closest configured role with a compatible model OR finish that part of the task yourself in the main session. Do not invent a roster entry.',
    '',
    '## Worker failure recovery',
    '',
    ...buildFailureRecoverySection(),
    ...swarmSection,
  ].join('\n')
}

function buildFailureRecoverySection(): string[] {
  const fb = getTeamModeFallbackWorker()
  const fbOn = isTeamModeFallbackEnabled()
  if (!fb || !fbOn) {
    return [
      'If a worker errors out (auth missing, provider down, model rejected the request, "Improperly formed request", "rate limit", quota exhausted), report the failure clearly and either retry on a different role from the roster or finish the task yourself in the main session. Do not silently give up — the user wants to know which worker failed and why.',
      '',
      '*(Tip: configure a shared worker fallback with `/team-mode fallback config` so the orchestrator can auto-retry failed workers on a backup provider.)*',
    ]
  }
  return [
    `A shared worker fallback is configured: **${formatTeamModeFallback(fb)}**.`,
    '',
    'When ANY worker spawn returns an error (look for patterns like "API error", "rate limit", "quota", "Improperly formed", "auth", "401", "403", "429", "5xx"), retry the SAME prompt ONCE on the fallback by re-issuing the Agent call with:',
    '',
    '```',
    `  provider: "${fb.provider}",`,
    `  model_id: "${fb.model}"`,
    '```',
    '',
    'Always announce the retry to the user in plain text: e.g. *"Worker `architect` (Kiro / claude-haiku-4.5) failed with `Improperly formed request`. Retrying on fallback (Anthropic / Sonnet)..."*. This mirrors the `/fallback` UX so the user knows which provider failed and which one took over.',
    '',
    'If the fallback ALSO fails, stop retrying. Surface both errors clearly and either complete the work yourself in the main session or ask the user how to proceed.',
  ]
}
