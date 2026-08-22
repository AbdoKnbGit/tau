import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { getAgentModelOptions } from '../../utils/model/agent.js'
import {
  getAPIProvider,
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
  SELECTABLE_PROVIDERS,
} from '../../utils/model/providers.js'
import { Select, type OptionWithDescription } from '../CustomSelect/select.js'
import { ProviderModelPicker } from '../ProviderModelPicker.js'

interface ModelSelectorProps {
  initialModel?: string
  initialProvider?: APIProvider
  onComplete: (model?: string, provider?: APIProvider) => void
  onCancel?: () => void
}

type Step = 'choice' | 'provider' | 'models'
const BROWSE_MODELS = '__browse_provider_models__'
const CURRENT_MODEL = '__current_provider_model__'

export function ModelSelector({
  initialModel,
  initialProvider,
  onComplete,
  onCancel,
}: ModelSelectorProps): React.ReactNode {
  const [step, setStep] = React.useState<Step>('choice')
  const [selectedProvider, setSelectedProvider] = React.useState<APIProvider>(
    initialProvider ?? getAPIProvider(),
  )

  const modelOptions = React.useMemo<OptionWithDescription<string>[]>(() => {
    const base: OptionWithDescription<string>[] = getAgentModelOptions()
    const options: OptionWithDescription<string>[] = []

    if (initialProvider && initialModel) {
      options.push({
        value: CURRENT_MODEL,
        label: `${PROVIDER_DISPLAY_NAMES[initialProvider]} / ${initialModel}`,
        description: 'Current provider-specific model',
      })
    } else if (
      initialModel &&
      !base.some(option => option.value === initialModel)
    ) {
      options.push({
        value: initialModel,
        label: initialModel,
        description: 'Current model (custom ID)',
      })
    }

    options.push(...base)
    options.push({
      value: BROWSE_MODELS,
      label: 'Browse provider models…',
      description: 'Pin this agent to any configured provider and model',
    })
    return options
  }, [initialModel, initialProvider])

  const cancel = (): void => {
    if (step !== 'choice') {
      setStep(step === 'models' ? 'provider' : 'choice')
      return
    }
    if (onCancel) onCancel()
    else onComplete(undefined, undefined)
  }

  if (step === 'provider') {
    const providerOptions: OptionWithDescription<APIProvider>[] =
      SELECTABLE_PROVIDERS.map(provider => ({
        value: provider,
        label: PROVIDER_DISPLAY_NAMES[provider],
        description: provider,
      }))

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text dimColor>Select the provider for this agent.</Text>
        </Box>
        <Select
          options={providerOptions}
          defaultValue={selectedProvider}
          onChange={(provider: APIProvider) => {
            setSelectedProvider(provider)
            setStep('models')
          }}
          onCancel={cancel}
        />
      </Box>
    )
  }

  if (step === 'models') {
    return (
      <ProviderModelPicker
        initialProvider={selectedProvider}
        lockedProvider={selectedProvider}
        onSelect={(provider, model) =>
          onComplete(model, provider as APIProvider)
        }
        onCancel={cancel}
      />
    )
  }

  const defaultModel = initialProvider
    ? CURRENT_MODEL
    : (initialModel ?? 'sonnet')

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>
          Choose an inherited model tier or pin a provider-specific model.
        </Text>
      </Box>
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={(value: string) => {
          if (value === BROWSE_MODELS) {
            setStep('provider')
          } else if (value === CURRENT_MODEL) {
            onComplete(initialModel, initialProvider)
          } else {
            onComplete(value, undefined)
          }
        }}
        onCancel={cancel}
      />
    </Box>
  )
}
