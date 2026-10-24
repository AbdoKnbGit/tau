import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import { BROWSABLE_MODEL_PROVIDERS } from '../utils/model/providerCatalog.js'
import {
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from '../utils/model/providers.js'
import {
  getCustomSubagentModel,
  getSubagentModelEnvOverride,
  getSubagentModelMode,
  type SubagentModelMode,
  type SubagentModelSetting,
} from '../utils/model/subagentModel.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'
import { ProviderModelPicker } from './ProviderModelPicker.js'

type Props = {
  initial: SubagentModelSetting
  /** The provider the custom model is picked for and saved under. */
  provider: APIProvider
  /** The whole setting to save; undefined deletes it. */
  onComplete: (setting: SubagentModelSetting) => void
  onCancel: () => void
}

/**
 * /config's Sub-agent model submenu: Auto, Same as main model, or a model
 * picked from the current provider's list (Custom), saved for that provider
 * only. Switching modes keeps the custom models already saved for every
 * provider. Picking a model changes nothing else: no effort, no provider.
 */
export function SubagentModelPicker({
  initial,
  provider,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const [step, setStep] = useState<'mode' | 'model'>('mode')
  const providerName = PROVIDER_DISPLAY_NAMES[provider]
  const currentMode = getSubagentModelMode(initial)
  const customModel = getCustomSubagentModel(initial, provider)
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
              description: customModel
                ? `${customModel} on ${providerName}; Enter picks another`
                : `Pick one of ${providerName}'s models`,
            },
          ]
        : []),
    ],
    [canBrowse, customModel, providerName],
  )

  function save(mode: SubagentModelMode, models = initial?.models): void {
    const hasModels = models !== undefined && Object.keys(models).length > 0
    if (mode === 'auto' && !hasModels) {
      onComplete(undefined)
      return
    }
    onComplete({
      mode: mode === 'auto' ? undefined : mode,
      ...(hasModels ? { models } : {}),
    })
  }

  if (step === 'model') {
    return (
      <ProviderModelPicker
        initialProvider={provider}
        lockedProvider={provider}
        allowOpenAIEffortSelection={false}
        deferSelectionEffects
        onSelect={(_provider, modelId) =>
          save('custom', { ...initial?.models, [provider]: modelId })
        }
        onCancel={() => setStep('mode')}
      />
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
          An agent file with its own model or provider keeps it.
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
          if (mode === 'custom') {
            setStep('model')
            return
          }
          save(mode)
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
