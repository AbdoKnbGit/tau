import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import type { EffortLevel } from '../../utils/effort.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import { isBilledAsExtraUsage } from '../../utils/extraUsage.js'
import {
  clearFastModeCooldown,
  isFastModeAvailable,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import {
  checkOpus1mAccess,
  checkSonnet1mAccess,
} from '../../utils/model/check1mAccess.js'
import {
  isOpus1mMergeEnabled,
} from '../../utils/model/model.js'
import { renderModelLabelForProvider } from '../../utils/model/display.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  getProviderBrowseLabel,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import { getAPIProvider, isThirdPartyProvider } from '../../utils/model/providers.js'
import { validateModel } from '../../utils/model/validateModel.js'
import { isSurfEnabled } from '../../utils/surf/state.js'

function commitModelSelection(args: {
  model: string | null
  effort: EffortLevel | undefined
  isFastMode: boolean
  setAppState: ReturnType<typeof useSetAppState>
  setMessages?: LocalJSXCommandContext['setMessages']
  previousModel: string | null
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  providerLabel?: string
}): void {
  const {
    model,
    effort,
    isFastMode,
    setAppState,
    setMessages,
    previousModel,
    onDone,
    providerLabel,
  } = args

  setAppState(prev => ({
    ...prev,
    mainLoopModel: model,
    mainLoopModelForSession: null,
    ...(effort !== undefined ? { effortValue: effort } : {}),
  }))

  // Thinking-block signatures are only cryptographically verified by
  // Anthropic. Strip ONLY when the active provider is firstParty and the
  // model actually changed — other providers go through adapters that
  // transform/drop these fields, so stripping would waste cache hits
  // without fixing anything.
  if (
    setMessages
    && model !== previousModel
    && getAPIProvider() === 'firstParty'
  ) {
    setMessages(stripSignatureBlocks)
  }

  let message = `Set model to ${chalk.bold(renderModelLabel(model))}`
  if (providerLabel) {
    message += ` for ${chalk.bold(providerLabel)}`
  }
  if (effort !== undefined) {
    message += ` with ${chalk.bold(effort)} effort`
  }

  let wasFastModeToggledOn: boolean | undefined
  if (isFastModeEnabled()) {
    clearFastModeCooldown()
    if (!isFastModeSupportedByModel(model) && isFastMode) {
      setAppState(prev => ({
        ...prev,
        fastMode: false,
      }))
      wasFastModeToggledOn = false
    } else if (isFastModeSupportedByModel(model) && isFastModeAvailable() && isFastMode) {
      message += ' · Fast mode ON'
      wasFastModeToggledOn = true
    }
  }

  if (isBilledAsExtraUsage(model, wasFastModeToggledOn === true, isOpus1mMergeEnabled())) {
    message += ' · Billed as extra usage'
  }
  if (wasFastModeToggledOn === false) {
    message += ' · Fast mode OFF'
  }

  onDone(message)
}

function ModelPickerWrapper({
  onDone,
  setMessages,
}: {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  setMessages: LocalJSXCommandContext['setMessages']
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const currentProvider = getAPIProvider()
  const lockedProvider =
    isThirdPartyProvider(currentProvider)
    && BROWSABLE_MODEL_PROVIDERS.includes(currentProvider as BrowsableModelProvider)
      ? (currentProvider as BrowsableModelProvider)
      : null

  function handleCancel(): void {
    logEvent('tengu_model_command_menu', {
      action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const displayModel = renderModelLabel(mainLoopModel)
    onDone(`Kept model as ${chalk.bold(displayModel)}`, {
      display: 'system',
    })
  }

  function handleSelect(
    model: string | null,
    effort: EffortLevel | undefined,
  ): void {
    logEvent('tengu_model_command_menu', {
      action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model:
        mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    commitModelSelection({
      model,
      effort,
      isFastMode,
      setAppState,
      setMessages,
      previousModel: mainLoopModel,
      onDone,
    })
  }

  function handleProviderSelect(
    provider: BrowsableModelProvider,
    modelId: string,
    effort?: EffortLevel,
  ): void {
    logEvent('tengu_model_command_menu', {
      action: modelId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model:
        mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model:
        modelId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    commitModelSelection({
      model: modelId,
      effort,
      isFastMode,
      setAppState,
      setMessages,
      previousModel: mainLoopModel,
      onDone,
      providerLabel: getProviderBrowseLabel(provider),
    })
  }

  const showFastModeNotice =
    isFastModeEnabled()
    && isFastMode
    && isFastModeSupportedByModel(mainLoopModel)
    && isFastModeAvailable()

  if (lockedProvider) {
    return (
      <ProviderModelPicker
        initialProvider={lockedProvider}
        lockedProvider={lockedProvider}
        onSelect={handleProviderSelect}
        onCancel={handleCancel}
      />
    )
  }

  return (
    <ModelPicker
      initial={mainLoopModel}
      sessionModel={mainLoopModelForSession}
      onSelect={handleSelect}
      onCancel={handleCancel}
      isStandaloneCommand
      showFastModeNotice={showFastModeNotice}
    />
  )
}

function SetModelAndClose({
  args,
  onDone,
  setMessages,
}: {
  args: string
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
  setMessages: LocalJSXCommandContext['setMessages']
}): React.ReactNode {
  const isFastMode = useAppState(s => s.fastMode)
  const setAppState = useSetAppState()
  const previousModel = useAppState(s => s.mainLoopModel)
  const model = args === 'default' ? null : args

  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(
          `Model '${model}' is not available. Your organization restricts model selection.`,
          {
            display: 'system',
          },
        )
        return
      }

      if (model && isOpus1mUnavailable(model)) {
        onDone(
          'Opus 4.7 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }
      if (model && isSonnet1mUnavailable(model)) {
        onDone(
          'Sonnet 4.6 with 1M context is not available for your account. Learn more: https://code.claude.com/docs/en/model-config#extended-context-with-1m',
          {
            display: 'system',
          },
        )
        return
      }

      if (!model) {
        setModel(null)
        return
      }

      if (isKnownAlias(model)) {
        setModel(model)
        return
      }

      try {
        const { valid, error } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error || `Model '${model}' not found`, {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(`Failed to validate model: ${(error as Error).message}`, {
          display: 'system',
        })
      }
    }

    function setModel(modelValue: string | null): void {
      commitModelSelection({
        model: modelValue,
        effort: undefined,
        isFastMode,
        setAppState,
        setMessages,
        previousModel,
        onDone,
      })
    }

    void handleModelChange()
  }, [isFastMode, model, onDone, setAppState, setMessages, previousModel])

  return null
}

function isKnownAlias(model: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(
    model.toLowerCase().trim(),
  )
}

function isOpus1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkOpus1mAccess()
    && !isOpus1mMergeEnabled()
    && m.includes('opus')
    && m.includes('[1m]')
  )
}

function isSonnet1mUnavailable(model: string): boolean {
  const m = model.toLowerCase()
  return (
    !checkSonnet1mAccess()
    && (m.includes('sonnet[1m]') || m.includes('sonnet-4-6[1m]'))
  )
}

function ShowModelAndClose({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)
  const effortValue = useAppState(s => s.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const effortInfo =
    effortValue !== undefined ? ` (effort: ${effortValue})` : ''

  if (mainLoopModelForSession) {
    onDone(
      `Current model: ${chalk.bold(renderModelLabel(mainLoopModelForSession))} (session override from plan mode)\nBase model: ${displayModel}${effortInfo}`,
    )
  } else {
    onDone(`Current model: ${displayModel}${effortInfo}`)
  }

  return null
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  args = args?.trim() || ''

  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('tengu_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }

  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Run /models to open the provider-aware model selection menu.',
      {
        display: 'system',
      },
    )
    return
  }

  if (isSurfEnabled()) {
    const lines = [
      `${chalk.bold('🌊 Surf is on')} — router is picking the model per phase.`,
      chalk.dim(
        'Run /surf off to switch models manually, or /surf config to re-pick surf targets.',
      ),
    ]
    onDone(lines.join('\n'), { display: 'system' })
    return
  }

  if (args) {
    logEvent('tengu_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return (
      <SetModelAndClose
        args={args}
        onDone={onDone}
        setMessages={context.setMessages}
      />
    )
  }

  return <ModelPickerWrapper onDone={onDone} setMessages={context.setMessages} />
}

function renderModelLabel(model: string | null): string {
  return renderModelLabelForProvider(model, getAPIProvider())
}
