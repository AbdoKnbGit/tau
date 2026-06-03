import chalk from 'chalk'
import * as React from 'react'
import { useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/index.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { Box, Text } from '../../ink.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { isAPIProvider, type APIProvider } from '../../utils/model/providers.js'
import {
  getDefaultBrowsableProvider,
  isVoiceConversationProvider,
  resolveProviderModelSelection,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import {
  formatTeamModeRole,
  getTeamModeFallbackWorker,
  isTeamModeFallbackEnabled,
  setTeamModeEnabledForSession,
  TEAM_MODE_ROLE_IDS,
  TEAM_MODE_ROLE_META,
  type TeamModeRole,
  type TeamModeRoleId,
} from '../../utils/teamMode/state.js'
import { syncTeamModeRuntimeConfig } from '../../utils/teamMode/runtime.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

type StepMode = 'menu' | 'picker'
type MenuChoice = 'configure' | 'skip' | 'finish' | 'cancel'

const TOTAL_STEPS = TEAM_MODE_ROLE_IDS.length

function commitRoster(
  roster: TeamModeRole[],
  enableOnFinish: boolean | undefined,
) {
  saveGlobalConfig(current => ({
    ...current,
    teamModeRoles: roster.map(r => ({
      role: r.role,
      provider: r.provider,
      model: r.model,
      effort: r.effort,
      active: r.active,
    })),
    teamModeEnabled: false,
  }))
  syncTeamModeRuntimeConfig({
    roles: roster,
    fallback: getTeamModeFallbackWorker(),
    fallbackEnabled: isTeamModeFallbackEnabled(),
    enabled: enableOnFinish === true,
    event: enableOnFinish
      ? 'team roster saved and enabled'
      : 'team roster saved',
  })
  // Drop the section cache so the next turn's system prompt picks up the new
  // roster — otherwise the orchestrator keeps showing the old binding until
  // /clear or /compact.
  clearSystemPromptSections()
}

function summaryLines(
  roster: TeamModeRole[],
  enableOnFinish: boolean | undefined,
): string[] {
  if (roster.length === 0) {
    return [
      chalk.bold('Team roster cleared.'),
      chalk.dim('No roles configured — run /team-mode config to set them.'),
    ]
  }
  const lines = [
    enableOnFinish
      ? chalk.bold('Team roster saved and team mode turned on.')
      : chalk.bold('Team roster saved.'),
    '',
  ]
  for (const r of roster) {
    const meta = TEAM_MODE_ROLE_META[r.role]
    const label = meta.label.padEnd(20)
    const stateTag = r.active ? chalk.green('[active]') : chalk.dim('[skipped]')
    lines.push(`  ${chalk.cyan(label)} ${stateTag} ${chalk.dim(formatTeamModeRole(r))}`)
  }
  lines.push('')
  lines.push(
    chalk.dim(
      'Use /team-mode on to start routing prompts through the team, /team-mode status to inspect, or /team-mode config to change it.',
    ),
  )
  return lines
}

export function TeamModeWizard({
  onDone,
  initialProvider,
  enableOnFinish,
  onTeamModeEnabled,
}: {
  onDone: OnDone
  initialProvider: APIProvider
  enableOnFinish?: boolean
  onTeamModeEnabled?: (roster: TeamModeRole[]) => void
}) {
  const [stepIndex, setStepIndex] = useState(0)
  const [mode, setMode] = useState<StepMode>('menu')
  const [roster, setRoster] = useState<TeamModeRole[]>([])
  const [lastProvider, setLastProvider] = useState<APIProvider>(initialProvider)

  const currentRoleId: TeamModeRoleId | undefined = TEAM_MODE_ROLE_IDS[stepIndex]
  const currentMeta = currentRoleId ? TEAM_MODE_ROLE_META[currentRoleId] : undefined

  function finalize(finalRoster: TeamModeRole[]) {
    commitRoster(finalRoster, enableOnFinish)
    if (enableOnFinish) {
      setTeamModeEnabledForSession(true)
      onTeamModeEnabled?.(finalRoster)
    }
    onDone(summaryLines(finalRoster, enableOnFinish).join('\n'), {
      display: 'system',
    })
  }

  function advance(updated: TeamModeRole[]) {
    const nextIndex = stepIndex + 1
    if (nextIndex >= TOTAL_STEPS) {
      finalize(updated)
      return
    }
    setRoster(updated)
    setMode('menu')
    setStepIndex(nextIndex)
  }

  function handleMenuChoice(choice: MenuChoice) {
    if (!currentRoleId) return
    if (choice === 'configure') {
      setMode('picker')
      return
    }
    if (choice === 'skip') {
      // Mark inactive only if a binding already exists from a prior run (we
      // preserve the previous provider+model so toggling back on is a no-op).
      const existing = roster.find(r => r.role === currentRoleId)
      const next: TeamModeRole[] = existing
        ? roster.map(r =>
            r.role === currentRoleId ? { ...r, active: false } : r,
          )
        : roster
      advance(next)
      return
    }
    if (choice === 'finish') {
      finalize(roster)
      return
    }
    // cancel
    onDone('Team mode configuration cancelled.', { display: 'system' })
  }

  function handlePickerSelect(
    provider: BrowsableModelProvider,
    modelId: string,
  ) {
    if (!currentRoleId) return
    // Voice conversation is a separate workflow; not a real APIProvider.
    // Bounce back to the menu without recording.
    if (isVoiceConversationProvider(provider) || !isAPIProvider(provider)) {
      setMode('menu')
      return
    }
    const selection = resolveProviderModelSelection(provider, modelId)
    const newRole: TeamModeRole = {
      role: currentRoleId,
      provider,
      model: selection.modelId,
      effort: selection.effort,
      active: true,
    }
    const next = [
      ...roster.filter(r => r.role !== currentRoleId),
      newRole,
    ]
    setLastProvider(provider)
    advance(next)
  }

  function handlePickerCancel() {
    setMode('menu')
  }

  if (!currentRoleId) {
    // Unreachable in practice — advance() finalizes when the last step
    // completes — but guards against state desync if we ever resurrect the
    // wizard with a stale stepIndex from saved progress.
    return null
  }

  if (mode === 'picker') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text bold color="claude">
            Team role {stepIndex + 1}/{TOTAL_STEPS}: {currentMeta?.label}
          </Text>
          <Text dimColor>
            Pick the provider and model to bind to this role.
          </Text>
        </Box>
        <ProviderModelPicker
          initialProvider={getDefaultBrowsableProvider(lastProvider)}
          onSelect={handlePickerSelect}
          onCancel={handlePickerCancel}
        />
      </Box>
    )
  }

  const existingBinding = roster.find(r => r.role === currentRoleId)
  const previousBindingsLines = roster
    .filter(r => TEAM_MODE_ROLE_IDS.indexOf(r.role) < stepIndex)
    .map(r => {
      const meta = TEAM_MODE_ROLE_META[r.role]
      const stateTag = r.active ? '[active]' : '[skipped]'
      return `  ${meta.label.padEnd(20)} ${stateTag} ${formatTeamModeRole(r)}`
    })

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="claude">
          Team role {stepIndex + 1}/{TOTAL_STEPS}: {currentMeta?.label}
        </Text>
        <Text dimColor>{currentMeta?.description}</Text>
      </Box>

      {previousBindingsLines.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          {previousBindingsLines.map(line => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {existingBinding && (
        <Box marginBottom={1}>
          <Text dimColor>
            Current binding: {formatTeamModeRole(existingBinding)}{' '}
            {existingBinding.active ? '[active]' : '[skipped]'}
          </Text>
        </Box>
      )}

      <Select
        options={[
          {
            label: existingBinding ? 'Re-bind provider and model' : 'Configure provider and model',
            value: 'configure',
            description: 'Open the provider/model picker',
          },
          {
            label: 'Skip this role',
            value: 'skip',
            description: 'Orchestrator will not spawn this role',
          },
          {
            label: 'Save and finish',
            value: 'finish',
            description: 'Save what you have so far and exit',
          },
          {
            label: 'Cancel',
            value: 'cancel',
            description: 'Discard changes and exit',
          },
        ]}
        onChange={(value: string) => handleMenuChoice(value as MenuChoice)}
        onCancel={() => handleMenuChoice('cancel')}
      />
    </Box>
  )
}
