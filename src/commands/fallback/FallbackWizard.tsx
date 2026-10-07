import chalk from 'chalk'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../ink.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import type { OpenAIReasoningLevel } from '../../utils/model/openaiReasoning.js'
import type { CommandResultDisplay } from '../../commands.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  FALLBACK_TARGET_COUNT,
  formatFallbackTarget,
  type FallbackTarget,
} from '../../utils/fallback/state.js'
import {
  getDefaultBrowsableProvider,
  resolveProviderModelSelection,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

export function FallbackWizard({
  onDone,
  initialProvider,
}: {
  onDone: OnDone
  initialProvider: BrowsableModelProvider
}) {
  const [targets, setTargets] = useState<FallbackTarget[]>([])
  const [lastProvider, setLastProvider] =
    useState<BrowsableModelProvider>(initialProvider)

  const currentStep = targets.length + 1

  function handleSelect(provider: BrowsableModelProvider, modelId: string, openaiEffort?: OpenAIReasoningLevel) {
    const selection = resolveProviderModelSelection(provider, modelId)
    const next = [
      ...targets,
      {
        provider,
        model: selection.modelId,
        effort: provider === 'openai' ? openaiEffort : selection.effort,
      },
    ]

    if (next.length >= FALLBACK_TARGET_COUNT) {
      saveGlobalConfig(current => ({
        ...current,
        fallbackEnabled: true,
        fallbackTargets: next,
      }))
      const lines = [
        `${chalk.bold('Fallback chain saved and turned on.')} Eligible provider failures will automatically continue with:`,
        '',
        ...next.map(
          (target, index) =>
            `  ${index + 1}. ${chalk.cyan(formatFallbackTarget(target))}`,
        ),
        '',
        chalk.dim(
          'Use /fallback off to disable, /fallback status to inspect, or /fallback config to change it.',
        ),
      ]
      onDone(lines.join('\n'), { display: 'system' })
      return
    }

    setTargets(next)
    setLastProvider(provider)
  }

  function handleCancel() {
    onDone('Fallback configuration cancelled.', { display: 'system' })
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="claude">
          Fallback model {currentStep}/{FALLBACK_TARGET_COUNT}
        </Text>
        <Text dimColor>
          Pick the next model in priority order. The first fallback is tried
          before the second and third.
        </Text>
      </Box>

      {targets.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          {targets.map((target, index) => (
            <Text
              key={`${target.provider}:${target.model}:${index}`}
              dimColor
            >
              {index + 1}. {formatFallbackTarget(target)}
            </Text>
          ))}
        </Box>
      )}

      <ProviderModelPicker
        initialProvider={getDefaultBrowsableProvider(lastProvider)}
        onSelect={handleSelect}
        onCancel={handleCancel}
      />
    </Box>
  )
}
