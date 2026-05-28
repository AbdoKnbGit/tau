import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { validateProviderAuth } from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { isAPIProvider, getAPIProvider, setActiveProvider, PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  isVoiceConversationProvider,
  resolveProviderModelSelection,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import {
  formatTeamModeFallback,
  formatTeamModeRole,
  getActiveTeamModeRoles,
  getTeamModeFallbackWorker,
  getTeamModeRoleSlots,
  hasConfiguredTeamModeFallback,
  hasConfiguredTeamModeRoster,
  isTeamModeEnabled,
  isTeamModeFallbackEnabled,
  TEAM_MODE_ROLE_META,
} from '../../utils/teamMode/state.js'
import { TeamModeWizard } from './TeamModeWizard.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function showHelp(onDone: OnDone) {
  const lines = [
    `${chalk.bold('/team-mode')} - multi-provider team auto-orchestration`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/team-mode')}          Open the wizard on first run, otherwise show status`,
    `  ${chalk.cyan('/team-mode on')}       Turn auto-orchestration on (every prompt routes through the team)`,
    `  ${chalk.cyan('/team-mode off')}      Turn auto-orchestration off but keep the configured roster`,
    `  ${chalk.cyan('/team-mode config')}   Re-bind providers and models for each role`,
    `  ${chalk.cyan('/team-mode status')}   Show toggle state and the role-by-role binding`,
    `  ${chalk.cyan('/team-mode reset')}    Clear the team roster`,
    `  ${chalk.cyan('/team-mode test')}     Validate that every active role's provider is authenticated`,
    `  ${chalk.cyan('/team-mode fallback')} Configure the shared worker fallback (subcommands: config|on|off|status|reset)`,
    '',
    chalk.bold('Roles:'),
    ...Object.values(TEAM_MODE_ROLE_META).map(
      meta => `  ${chalk.cyan(meta.label.padEnd(20))} ${chalk.dim(meta.description)}`,
    ),
    '',
    chalk.dim('Each role can be bound to a different provider+model. The'),
    chalk.dim('orchestrator runs in the main session and dispatches the others.'),
  ]
  onDone(lines.join('\n'), { display: 'system' })
}

function showStatus(onDone: OnDone) {
  const slots = getTeamModeRoleSlots()
  const enabled = isTeamModeEnabled()
  const lines: string[] = [`${chalk.bold('/team-mode status')}`]

  lines.push(
    '',
    `${chalk.bold('Mode:')} ${enabled ? chalk.green('on') : chalk.dim('off')}`,
  )

  const configured = slots.filter(s => s.binding !== null)
  if (configured.length === 0) {
    lines.push('', 'No team roster configured.')
    lines.push(
      chalk.dim('Run /team-mode config to bind providers and models to each role.'),
    )
    onDone(lines.join('\n'), { display: 'system' })
    return
  }

  lines.push('', chalk.bold('Roster:'))
  for (const { meta, binding } of slots) {
    const label = meta.label.padEnd(20)
    if (binding === null) {
      lines.push(`  ${chalk.dim(label)} ${chalk.dim('(not configured)')}`)
      continue
    }
    const stateTag = binding.active
      ? chalk.green('[active]')
      : chalk.dim('[skipped]')
    lines.push(
      `  ${chalk.cyan(label)} ${stateTag} ${chalk.dim(formatTeamModeRole(binding))}`,
    )
  }

  if (!enabled) {
    lines.push(
      '',
      chalk.dim('Run /team-mode on to start routing prompts through the team.'),
    )
  }

  // Fallback summary at the bottom so the user sees it next to the roster.
  const fb = getTeamModeFallbackWorker()
  if (fb) {
    const fbState = isTeamModeFallbackEnabled()
      ? chalk.green('[on]')
      : chalk.dim('[off]')
    lines.push(
      '',
      `${chalk.bold('Worker fallback:')} ${fbState} ${chalk.dim(formatTeamModeFallback(fb))}`,
    )
  }

  onDone(lines.join('\n'), { display: 'system' })
}

function resetTeamMode(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeEnabled: undefined,
    teamModeRoles: undefined,
  }))
  // Drop the cached orchestrator addendum so the next turn rebuilds the
  // system prompt without it. Without this, the addendum keeps firing for
  // the rest of the session even though the user reset.
  clearSystemPromptSections()
  onDone(`${chalk.bold('Team mode reset.')} Roster cleared.`, {
    display: 'system',
  })
}

function turnTeamModeOff(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeEnabled: false,
  }))
  clearSystemPromptSections()
  onDone(
    `${chalk.bold('Team mode off.')} Configured roster was kept.`,
    { display: 'system' },
  )
}

function runTeamModeTest(onDone: OnDone) {
  const roles = getActiveTeamModeRoles()
  if (roles.length === 0) {
    onDone(
      [
        chalk.bold('/team-mode test'),
        '',
        'No active roles configured. Run /team-mode config to bind providers and models to each role.',
      ].join('\n'),
      { display: 'system' },
    )
    return
  }

  // Auth validation only — checks that each role's provider has stored
  // credentials and they pass format checks. This catches the common "forgot
  // to /login kiro" failure before a real task tries to spawn a worker on
  // that provider. We deliberately don't make a network call: tokens that
  // were valid at /login time are usually still valid; refresh happens
  // lazily on first real request. Saving a probe avoids burning tokens.
  const lines = [chalk.bold('/team-mode test'), '']
  let allPass = true
  for (const role of roles) {
    const meta = TEAM_MODE_ROLE_META[role.role]
    const label = meta.label.padEnd(20)
    const check = validateProviderAuth(role.provider)
    if (check.valid) {
      const methodTag = check.method ? ` (${check.method})` : ''
      lines.push(
        `  ${chalk.cyan(label)} ${chalk.green('PASS')} ${chalk.dim(formatTeamModeRole(role))}${chalk.dim(methodTag)}`,
      )
    } else {
      allPass = false
      const reason = check.reason ?? 'credentials missing or invalid'
      lines.push(
        `  ${chalk.cyan(label)} ${chalk.red('FAIL')} ${chalk.dim(formatTeamModeRole(role))}`,
      )
      lines.push(`      ${chalk.red('→')} ${reason}`)
    }
  }
  lines.push('')
  if (allPass) {
    lines.push(
      chalk.green('All active roles authenticated.'),
      chalk.dim('Note: this checks stored credentials only — it does not make a network call. Run a real task to verify the providers respond.'),
    )
  } else {
    lines.push(
      chalk.yellow('Some roles failed auth. Run /login <provider> for each failing role.'),
    )
  }

  onDone(lines.join('\n'), { display: 'system' })
}

function showFallbackStatus(onDone: OnDone) {
  const fb = getTeamModeFallbackWorker()
  const enabled = isTeamModeFallbackEnabled()
  const lines = [chalk.bold('/team-mode fallback status'), '']
  lines.push(
    `${chalk.bold('Mode:')} ${enabled ? chalk.green('on') : chalk.dim('off')}`,
  )
  if (!fb) {
    lines.push('', 'No fallback worker configured.')
    lines.push(
      chalk.dim('Run /team-mode fallback config to bind a shared backup provider+model.'),
    )
  } else {
    lines.push('', `${chalk.bold('Fallback worker:')} ${chalk.cyan(formatTeamModeFallback(fb))}`)
    if (!enabled) {
      lines.push(
        '',
        chalk.dim('Run /team-mode fallback on to start retrying failed workers on this backup.'),
      )
    }
  }
  onDone(lines.join('\n'), { display: 'system' })
}

function turnFallbackOff(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeFallbackEnabled: false,
  }))
  clearSystemPromptSections()
  onDone(
    `${chalk.bold('Team-mode fallback off.')} Configured fallback was kept.`,
    { display: 'system' },
  )
}

function turnFallbackOn(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeFallbackEnabled: true,
  }))
  clearSystemPromptSections()
  onDone(
    `${chalk.bold('Team-mode fallback on.')} Worker failures will retry once on the configured fallback.`,
    { display: 'system' },
  )
}

function resetFallback(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeFallbackEnabled: undefined,
    teamModeFallbackWorker: undefined,
  }))
  clearSystemPromptSections()
  onDone(`${chalk.bold('Team-mode fallback reset.')} Configuration cleared.`, {
    display: 'system',
  })
}

// One-shot picker for the shared worker fallback. Reuses ProviderModelPicker
// — single (provider, model) selection, not a multi-step roster wizard.
function FallbackPicker({ onDone }: { onDone: OnDone }) {
  function handleSelect(
    provider: BrowsableModelProvider,
    modelId: string,
  ) {
    if (isVoiceConversationProvider(provider) || !isAPIProvider(provider)) {
      onDone('Fallback configuration cancelled (voice conversation is not a worker provider).', {
        display: 'system',
      })
      return
    }
    const selection = resolveProviderModelSelection(provider, modelId)
    saveGlobalConfig(current => ({
      ...current,
      teamModeFallbackWorker: {
        provider,
        model: selection.modelId,
        effort: selection.effort,
      },
      teamModeFallbackEnabled: true,
    }))
    clearSystemPromptSections()
    const fb = { provider, model: selection.modelId, effort: selection.effort }
    onDone(
      [
        chalk.bold('Team-mode fallback saved and turned on.'),
        '',
        `Worker fallback: ${chalk.cyan(formatTeamModeFallback(fb))}`,
        '',
        chalk.dim('When a worker fails on its primary provider, the orchestrator will retry once on this fallback.'),
        chalk.dim('Use /team-mode fallback off to disable, /team-mode fallback status to inspect.'),
      ].join('\n'),
      { display: 'system' },
    )
  }
  function handleCancel() {
    onDone('Fallback configuration cancelled.', { display: 'system' })
  }
  return (
    <ProviderModelPicker
      initialProvider={getAPIProvider()}
      onSelect={handleSelect}
      onCancel={handleCancel}
    />
  )
}

function turnTeamModeOn(onDone: OnDone) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeEnabled: true,
  }))
  // Cache flush so the next turn picks up the orchestrator addendum. Toggling
  // mid-session costs one prompt-cache miss; toggling off-on stays warm.
  clearSystemPromptSections()

  // Apply the orchestrator role's binding eagerly so the UI (status line,
  // /model display, /provider display) reflects the orchestrator's pinned
  // provider+model immediately. Without this, getAPIProvider()/getMainLoopModel()
  // still return the correct values via their lazy-resolved team-mode checks,
  // but the status surface lags until the next config-refresh tick. Eager
  // apply also persists the choice so the next session boots into the
  // orchestrator's binding without depending on the lazy resolution path.
  const orchestrator = getActiveTeamModeRoles().find(r => r.role === 'orchestrator')
  let appliedLine = ''
  if (orchestrator) {
    setActiveProvider(orchestrator.provider)
    setMainLoopModelOverride(orchestrator.model)
    const provider = PROVIDER_DISPLAY_NAMES[orchestrator.provider]
    appliedLine = `\nOrchestrator: ${chalk.cyan(`${provider} / ${orchestrator.model}`)}`
  }

  onDone(
    `${chalk.bold('Team mode on.')} Prompts will be routed through the configured team.${appliedLine}`,
    { display: 'system' },
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const subcommand = (args?.trim() || '').toLowerCase()

  // Two-word subcommands: "/team-mode fallback ..." routes to a separate
  // dispatcher so the existing single-word switch stays clean.
  if (subcommand.startsWith('fallback')) {
    const fbSub = subcommand.slice('fallback'.length).trim()
    switch (fbSub) {
      case '':
      case 'status':
        showFallbackStatus(onDone)
        return
      case 'config':
      case 'setup':
        return <FallbackPicker onDone={onDone} />
      case 'on': {
        if (!hasConfiguredTeamModeFallback()) {
          return <FallbackPicker onDone={onDone} />
        }
        turnFallbackOn(onDone)
        return
      }
      case 'off':
        turnFallbackOff(onDone)
        return
      case 'reset':
        resetFallback(onDone)
        return
      default:
        onDone(
          [
            chalk.bold('/team-mode fallback'),
            '',
            chalk.bold('Usage:'),
            `  ${chalk.cyan('/team-mode fallback')}          Show status / open wizard if unconfigured`,
            `  ${chalk.cyan('/team-mode fallback config')}   Pick the shared worker fallback provider+model`,
            `  ${chalk.cyan('/team-mode fallback on')}       Turn fallback on`,
            `  ${chalk.cyan('/team-mode fallback off')}      Turn fallback off but keep the config`,
            `  ${chalk.cyan('/team-mode fallback status')}   Show fallback state`,
            `  ${chalk.cyan('/team-mode fallback reset')}    Clear the fallback config`,
          ].join('\n'),
          { display: 'system' },
        )
        return
    }
  }

  switch (subcommand) {
    case 'help':
    case '-h':
    case '--help':
    case '?':
      showHelp(onDone)
      return

    case 'status':
      showStatus(onDone)
      return

    case 'config':
    case 'setup':
      return (
        <TeamModeWizard
          onDone={onDone}
          initialProvider={getAPIProvider()}
        />
      )

    case 'on': {
      if (!hasConfiguredTeamModeRoster()) {
        return (
          <TeamModeWizard
            onDone={onDone}
            initialProvider={getAPIProvider()}
            enableOnFinish
          />
        )
      }
      turnTeamModeOn(onDone)
      return
    }

    case 'off':
      turnTeamModeOff(onDone)
      return

    case 'reset':
      resetTeamMode(onDone)
      return

    case 'test':
      runTeamModeTest(onDone)
      return

    case '': {
      if (!hasConfiguredTeamModeRoster()) {
        return (
          <TeamModeWizard
            onDone={onDone}
            initialProvider={getAPIProvider()}
          />
        )
      }
      showStatus(onDone)
      return
    }

    default:
      showHelp(onDone)
      return
  }
}
