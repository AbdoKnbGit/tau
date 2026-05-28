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

// Insert `separator` between consecutive items of `items`. Used so each role
// block / spawn template in the orchestrator prompt is followed by a blank
// line, keeping the rendered markdown legible without trailing separators.
function interleave<T>(items: readonly T[], separator: T): T[] {
  const out: T[] = []
  for (let i = 0; i < items.length; i++) {
    if (i > 0) out.push(separator)
    out.push(items[i]!)
  }
  return out
}

export function getTeamModeOrchestratorAddendum(): string | null {
  if (!isTeamModeEnabled()) return null
  const roles = getActiveTeamModeRoles()
  if (roles.length === 0) return null

  // Sorted by role id (stable order from TEAM_MODE_ROLE_IDS) so identical
  // rosters produce identical strings across sessions and turns. Don't sort
  // by display label — that's the same in practice but ordering by id makes
  // the contract explicit.
  //
  // Format is structured (one binding per fenced block, fields on their own
  // lines) rather than a `display-name / model-id` single line. The previous
  // format collided with model ids that contain slashes ("tencent/hy3-preview",
  // "openai/gpt-oss-120b") and forced the LLM to translate display names
  // ("OpenRouter") back to enum values ("openrouter") at spawn time — both
  // failure modes caused the orchestrator to grab the wrong row's model_id
  // (gh: "agent tried to use Architect's model instead of Implementer's").
  const rosterBlocks = roles.map(role => {
    const meta = TEAM_MODE_ROLE_META[role.role]
    const displayName = PROVIDER_DISPLAY_NAMES[role.provider]
    return [
      `### ${meta.label} (role id: \`${role.role}\`) — ${meta.description}`,
      '```',
      `provider:  "${role.provider}"   // ${displayName}`,
      `model_id:  "${role.model}"`,
      '```',
    ].join('\n')
  })

  // Per-role copy-paste spawn templates. Each role gets its OWN block with
  // the literal provider + model_id values pre-filled — no lookup, no
  // translation. The orchestrator picks the role's block, copies it, fills
  // in description + prompt, and sends. No way to swap roster rows by
  // accident because the values are baked into the example.
  //
  // We also include `name: "<role-id>"` so the runtime's tier-1 validation
  // can pin the spawn to that specific role's binding — catching the case
  // where two roles share a provider but differ in model_id and the LLM
  // grabs the wrong row's model.
  const spawnExamples = roles.map(role => {
    const meta = TEAM_MODE_ROLE_META[role.role]
    return [
      `**Spawn ${meta.label}:**`,
      '```',
      'Agent({',
      '  subagent_type: "general-purpose",',
      `  name: "${role.role}",`,
      '  description: "<3-5 word phase title>",',
      '  prompt: "<task for this worker>",',
      `  provider: "${role.provider}",`,
      `  model_id: "${role.model}"`,
      '})',
      '```',
    ].join('\n')
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
    'You are operating with /team-mode ON. The user has bound a fixed roster of specialized roles to specific provider+model pairs.',
    '',
    '**Hard rules — the runtime ENFORCES these and rejects any spawn that violates them:**',
    '',
    '1. Every Agent call MUST include `name` set to the role id you are spawning (e.g. `"implementer"`, `"architect"`). This is how you declare intent.',
    '2. The `provider` and `model_id` you pass MUST match the role named in `name` EXACTLY. The runtime cross-checks: if `name: "implementer"` is paired with the Architect\'s `provider`/`model_id`, the spawn is rejected with `team-mode role binding mismatch`.',
    '3. Use the per-role spawn templates below — they have `name`, `provider`, and `model_id` already filled in correctly. Copy the WHOLE block for the role you want, then fill in `description` and `prompt`. Never hand-edit the three pinned fields.',
    '',
    '## Configured role bindings',
    '',
    ...interleave(rosterBlocks, ''),
    '',
    '## Your job as Orchestrator',
    '',
    'You PLAN, DELEGATE, and SYNTHESIZE. You DO NOT do worker work yourself. Concretely:',
    '',
    '- **DO NOT** edit files (no Edit, Write, NotebookEdit, file_replace, etc.). That is the Implementer\'s job. If you catch yourself reaching for a file-edit tool, stop and spawn the Implementer instead.',
    '- **DO NOT** run shell commands that change state (installs, builds, tests, deploys, migrations). That is the Verifier\'s or DevOps\' job depending on the surface.',
    '- **DO NOT** write the design or pick the implementation strategy yourself for any task that touches more than one file. That is the Architect\'s job.',
    '- **DO** read files, run read-only shell (`git status`, `ls`, `grep`), and ask clarifying questions — those keep you informed enough to plan.',
    '- **DO** spawn workers for everything else, **DO** wait for their results, **DO** combine those results into a single user-facing response.',
    '',
    'The only exception is a single, undeniably trivial action: one file rename, one config-line tweak the user dictated verbatim, a one-line typo fix, or a direct factual answer. Anything bigger goes through workers.',
    '',
    '## Required workflow for code changes',
    '',
    'When the task involves editing the codebase, run these phases in order. Skip a phase ONLY if its trigger is not present (e.g. no docs change → skip Docs).',
    '',
    '1. **Explore** *(when the area is unfamiliar to you)*: spawn `explorer` to map files, call graphs, and existing patterns. Wait for its report.',
    '2. **Architect** *(when the change touches >1 file, adds modules, or changes an API)*: spawn `architect` with the user\'s task + Explorer\'s report (if any). Get back a concrete plan.',
    '3. **Implement**: spawn `implementer` with the user\'s task + Architect\'s plan. The Implementer owns ALL file edits.',
    '4. **Review + Verify in parallel**: in the same tool-call message, spawn `reviewer` (reads the diff) AND `verifier` (runs tests/builds). They do not edit files; they only report findings.',
    '5. **DevOps / Docs / Dependency Manager** *(only when triggered)*: spawn each role whose surface the task touched. CI changed → DevOps. Public behavior changed → Docs. Dependencies added/removed → Dependency Manager.',
    '6. **Loop on findings**: if Reviewer or Verifier surfaces actionable findings, spawn `implementer` again with those findings. Then Review+Verify again. Stop when both come back clean OR the user explicitly accepts known issues.',
    '7. **Synthesize**: write the final user-facing response yourself. Quote file paths, summarize what each role did and the outcome, and call out anything the user needs to act on.',
    '',
    'For pure exploration / research tasks (no code changes), use Explorer + Architect only, then synthesize.',
    '',
    '## Spawn templates (per role — copy verbatim)',
    '',
    'Pick the role you need, copy its block, fill in `description` + `prompt`, send. The `name`, `provider`, and `model_id` values are already correct; do not edit them. The runtime rejects spawns where `name` is missing or where the pair does not match the role.',
    '',
    ...interleave(spawnExamples, ''),
    '',
    'Spawn multiple workers in the SAME tool-call message when their work is independent (e.g. Reviewer + Verifier at the same time) — that gives you true parallelism across providers.',
    '',
    '## Conflict prevention',
    '',
    'Two workers must not edit the same file in the same wave. The phased workflow above already enforces this because Implementer is the only role that edits files. If you ever need parallel implementation work, split by directory or by feature so each Implementer call owns disjoint files.',
    '',
    '## Synthesis',
    '',
    'After workers complete, write the final response yourself. Quote relevant file paths and decisions. Do NOT paste large blobs of worker output verbatim — distill them. Tell the user what changed, what was tested, and what (if anything) they need to do next.',
    '',
    '## Missing roles',
    '',
    'The roster above lists only the roles the user has configured. If your task needs a role that is NOT in the roster (e.g. you need a Verifier but no Verifier is bound), do the work via the closest configured role that has a capable model, OR tell the user the role is missing and ask them to configure it via `/team-mode config`. Do not invent a roster entry, and do not silently bypass the missing phase.',
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
