import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  type BrowsableModelProvider,
  isVoiceConversationProvider,
} from '../utils/model/providerCatalog.js'
import {
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from '../utils/model/providers.js'
import {
  getCustomSubagentTarget,
  getGlobalSubagentTarget,
  getSubagentModelEnvOverride,
  getSubagentModelMode,
  type SubagentModelMode,
  type SubagentModelSetting,
  type SubagentModelTarget,
  toSubagentModelEntry,
} from '../utils/model/subagentModel.js'
import { resolveSubagentModelPick } from '../utils/model/subagentModelPick.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'
import { getProviderStatusLabel, ProviderModelPicker } from './ProviderModelPicker.js'

type Props = {
  initial: SubagentModelSetting
  /** The provider the custom model is picked for and saved under. */
  provider: APIProvider
  /** The whole setting to save; undefined deletes it. */
  onComplete: (setting: SubagentModelSetting) => void
  onCancel: () => void
}

function describePick(target: SubagentModelTarget): string {
  return target.effort === undefined ? target.model : `${target.model} · ${target.effort}`
}

/**
 * /config's Sub-agent model submenu: Auto, Same as main model, a model picked
 * from the current provider's list (Custom, saved for that provider only),
 * or one from any provider you are logged in to (Global, used whatever the
 * main provider). Custom and Global take an effort from the row as /models
 * does, for sub-agents alone. Picking changes nothing else: the session's
 * provider, model and effort stay as they are, and switching modes keeps
 * every pick already saved.
 */
export function SubagentModelPicker({
  initial,
  provider,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [step, setStep] = useState<'mode' | 'custom' | 'global'>('mode')
  const [error, setError] = useState<string | null>(null)
  const providerName = PROVIDER_DISPLAY_NAMES[provider]
  const currentMode = getSubagentModelMode(initial)
  const customTarget = getCustomSubagentTarget(initial, provider)
  const globalTarget = getGlobalSubagentTarget(initial)
  const envOverride = getSubagentModelEnvOverride()
  const canBrowse = BROWSABLE_MODEL_PROVIDERS.includes(provider)

  const options = useMemo<OptionWithDescription<SubagentModelMode>[]>(
    () => [
      {
        label: 'Auto',
        value: 'auto',
        description: "The provider's usual sub-agent model, as before (default)",
      },
      {
        label: 'Same as main model',
        value: 'inherit',
        description: 'Sub-agents run on the model you are using',
      },
      ...(canBrowse
        ? [
            {
              label: 'Custom model…',
              value: 'custom' as const,
              description: customTarget
                ? `${describePick(customTarget)} on ${providerName}; Enter picks another`
                : `Pick one of ${providerName}'s models, and its effort`,
            },
          ]
        : []),
      {
        label: 'Global model…',
        value: 'global',
        description: globalTarget
          ? `${PROVIDER_DISPLAY_NAMES[globalTarget.provider]} / ${describePick(globalTarget)}, whatever the main provider; Enter picks another`
          : 'One model, and its effort, from any provider you are logged in to, whatever the main provider',
      },
    ],
    [canBrowse, customTarget, globalTarget, providerName],
  )

  function save(
    mode: SubagentModelMode,
    models = initial?.models,
    global = initial?.global,
  ): void {
    const hasModels = models !== undefined && Object.keys(models).length > 0
    if (mode === 'auto' && !hasModels && global === undefined) {
      onComplete(undefined)
      return
    }
    onComplete({
      mode: mode === 'auto' ? undefined : mode,
      ...(hasModels ? { models } : {}),
      ...(global !== undefined ? { global } : {}),
    })
  }

  function back(): void {
    setError(null)
    setStep('mode')
  }

  if (step === 'custom' || step === 'global') {
    return (
      <Box flexDirection="column">
        {error !== null && <Text color="error">{error}</Text>}
        <ProviderModelPicker
          initialProvider={
            step === 'custom'
              ? provider
              : (globalTarget?.provider ?? provider) as BrowsableModelProvider
          }
          {...(step === 'custom' ? { lockedProvider: provider } : {})}
          deferSelectionEffects
          onSelect={(picked, modelId, openaiEffort, _commit, providerEffort) => {
            if (isVoiceConversationProvider(picked)) {
              setError('A voice cannot run sub-agents: pick a model.')
              return
            }
            if (step === 'global' && getProviderStatusLabel(picked) === 'login required') {
              setError(`Log in to ${PROVIDER_DISPLAY_NAMES[picked]} first (/provider or /login), then pick its model here.`)
              return
            }
            const pick = resolveSubagentModelPick(picked, modelId, openaiEffort, providerEffort)
            if (!pick.ok) {
              setError(pick.message)
              return
            }
            if (step === 'custom') {
              save('custom', { ...initial?.models, [provider]: toSubagentModelEntry(pick.target) })
              return
            }
            // Every key, even an absent effort (undefined deletes it): the
            // save merges into settings.json and must not keep the last one.
            const { provider: targetProvider, model, effort } = pick.target
            save('global', initial?.models, { provider: targetProvider, model, effort })
          }}
          onCancel={back}
        />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text>
          Model for built-in agents and agent files that name no model or
          provider:
        </Text>
        <Text dimColor>
          An agent file with its own model or provider keeps it. An effort
          picked here applies to sub-agents alone.
        </Text>
      </Box>
      {envOverride !== undefined && (
        <Text color="warning">
          CLAUDE_CODE_SUBAGENT_MODEL={envOverride} is set and overrides this
          until you unset it.
        </Text>
      )}
      {!canBrowse && (
        <Text dimColor>
          Custom is not available for {providerName}: set
          subagentModel.models.{provider} in settings.json.
        </Text>
      )}
      <Select
        options={options}
        layout="compact-vertical"
        defaultValue={currentMode}
        defaultFocusValue={currentMode}
        onChange={(mode: SubagentModelMode) => {
          if (mode === 'custom' || mode === 'global') {
            setStep(mode)
            return
          }
          save(mode)
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
