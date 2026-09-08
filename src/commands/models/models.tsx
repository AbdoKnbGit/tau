import chalk from 'chalk'
import * as React from 'react'
import { setMainLoopModelOverride } from '../../bootstrap/state.js'
import { ProviderModelPicker } from '../../components/ProviderModelPicker.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import type { AppState } from '../../state/AppStateStore.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  setActiveProvider,
} from '../../utils/model/providers.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  filterProviderModels,
  getDefaultBrowsableProvider,
  getProviderBrowseLabel,
  isVoiceConversationProvider,
  loadProviderModels,
  parseProviderModelQuery,
  resolveProviderModelSelection,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import { getProviderModelDisplayName } from '../../utils/model/display.js'
import { isConcreteOpenAIGptModelForProvider } from '../../utils/model/openaiGptModels.js'
import {
  getLiveVoiceDisplayName,
  setSelectedLiveVoice,
} from '../../voice/voiceConversation.js'
import { setClineEffort } from '../../utils/model/clineThinking.js'
import { isClinePassProvider } from '../../utils/model/clinePassCatalog.js'

function renderSearchBadges(tags?: readonly string[]): string {
  if (!tags || tags.length === 0) {
    return ''
  }

  const badges: string[] = []
  if (tags.includes('recommended')) {
    badges.push(chalk.green('[RECOMMENDED]'))
  }
  if (tags.includes('free')) {
    badges.push(chalk.green('[FREE]'))
  }

  return badges.length > 0 ? ` ${badges.join(' ')}` : ''
}

function ModelsPickerWrapper({
  onDone,
  lockedProvider,
  setMessages,
}: {
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  lockedProvider?: BrowsableModelProvider
  setMessages: LocalJSXCommandContext['setMessages']
}) {
  const setAppState = useSetAppState()
  const currentProvider = getAPIProvider()
  const currentModel = useAppState((s: AppState) => s.mainLoopModel)
  const initialProvider = lockedProvider ?? getDefaultBrowsableProvider(currentProvider)

  function handleSelect(provider: BrowsableModelProvider, modelId: string) {
    if (isVoiceConversationProvider(provider)) {
      const result = setSelectedLiveVoice(modelId)
      if (result.error) {
        onDone(
          `Failed to save Codex voice: ${result.error.message}`,
          { display: 'system' },
        )
        return
      }
      const displayModel =
        getLiveVoiceDisplayName(modelId) ?? modelId
      onDone(`Set Codex voice to ${chalk.bold(displayModel)}. Applies to the next /hey session.`)
      return
    }

    const selection = resolveProviderModelSelection(provider, modelId)

    if (isClinePassProvider(provider) && selection.clineEffort) {
      setClineEffort(selection.modelId, selection.clineEffort)
    }

    const providerChanged = currentProvider !== provider
    const modelChanged = currentModel !== selection.modelId
    if (providerChanged) {
      setActiveProvider(provider)
    }
    if (isConcreteOpenAIGptModelForProvider(selection.modelId, provider)) {
      setMainLoopModelOverride(selection.modelId)
    }

    setAppState(prev => ({
      ...prev,
      mainLoopModel: selection.modelId,
      mainLoopModelForSession: null,
      ...(provider === 'firstParty'
        ? { effortValue: selection.effort }
        : selection.effort
          ? { effortValue: selection.effort }
          : {}),
    }))

    // Thinking-block signatures are only cryptographically verified by
    // Anthropic (firstParty) — their API rejects mismatched ones with 400.
    // Strip ONLY when the target provider is firstParty:
    //   - firstParty → firstParty (different model or effort): strip, because
    //     Anthropic will verify and reject.
    //   - anyProvider → firstParty: strip, same reason.
    //   - firstParty → other: no strip — other providers' adapters drop or
    //     transform these fields, so stripping would just waste cache hits.
    //   - other → other: no strip — no verification happens, signatures (if
    //     any) are provider round-trip metadata the adapter handles.
    // Scoping to firstParty preserves cache and tool_use integrity on every
    // non-Anthropic switch while still fixing the Anthropic 400.
    if ((providerChanged || modelChanged) && provider === 'firstParty') {
      setMessages(stripSignatureBlocks)
    }

    const providerNote = currentProvider !== provider
      ? ` (switched to ${chalk.bold(PROVIDER_DISPLAY_NAMES[provider])})`
      : ''

    const displayModel =
      getProviderModelDisplayName(provider, selection.modelId)
      ?? selection.modelId
    const effortNote = selection.effort
      ? ` with ${chalk.bold(selection.effort)} effort`
      : selection.clineEffort
        ? ` with ${chalk.bold(selection.clineEffort === 'none' ? 'Off' : selection.clineEffort === 'xhigh' ? 'Extra High' : selection.clineEffort)} thinking`
      : ''

    onDone(`Set model to ${chalk.bold(displayModel)}${effortNote}${providerNote}`)
  }

  function handleCancel() {
    onDone('Model selection cancelled', { display: 'system' })
  }

  return (
    <ProviderModelPicker
      initialProvider={initialProvider}
      lockedProvider={lockedProvider}
      onSelect={handleSelect}
      onCancel={handleCancel}
    />
  )
}

async function showSearchResults(
  rawArgs: string,
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  const fallbackProvider = getDefaultBrowsableProvider(getAPIProvider())
  const { provider, query } = parseProviderModelQuery(rawArgs, fallbackProvider)

  let models
  try {
    models = await loadProviderModels(provider)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onDone(
      `Unable to load models from ${chalk.bold(getProviderBrowseLabel(provider))}: ${message}`,
      { display: 'system' },
    )
    return
  }

  const results = filterProviderModels(models, query)

  if (results.length === 0) {
    onDone(
      `No ${getProviderBrowseLabel(provider)} models match "${chalk.bold(query)}". Try ${chalk.cyan('/models')} to browse providers and models interactively.`,
      { display: 'system' },
    )
    return
  }

  const lines = [
    `${chalk.bold(getProviderBrowseLabel(provider))} - ${chalk.bold(String(results.length))} model${results.length === 1 ? '' : 's'}${query ? ` matching "${chalk.bold(query)}"` : ''}`,
    '',
    ...results.slice(0, 20).map(
      model =>
        `  ${chalk.cyan(model.id)}${model.name && model.name !== model.id ? ` - ${model.name}` : ''}${renderSearchBadges(model.tags)}`,
    ),
  ]

  if (results.length > 20) {
    lines.push(
      `  ... and ${results.length - 20} more. Use /models to browse interactively.`,
    )
  }

  lines.push('')
  lines.push(chalk.dim('Use /models to open the provider-aware picker.'))

  onDone(lines.join('\n'), { display: 'system' })
}

function showHelp(
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void,
) {
  const providerList = BROWSABLE_MODEL_PROVIDERS.map(
    provider => `  ${chalk.bold(getProviderBrowseLabel(provider))}`,
  ).join('\n')

  const lines = [
    `${chalk.bold('/models')} - provider-aware model browser`,
    '',
    chalk.bold('Usage:'),
    `  ${chalk.cyan('/models')}                    Pick a provider, then browse its models`,
    `  ${chalk.cyan('/models <query>')}            Search the active provider's models`,
    `  ${chalk.cyan('/models <provider>:<query>')} Search a specific provider`,
    `  ${chalk.cyan('/models <provider>')}         List models from one provider`,
    '',
    chalk.bold('Browsable Providers:'),
    providerList,
    '',
    chalk.bold('Examples:'),
    `  ${chalk.cyan('/models')}                      Open provider + model picker`,
    `  ${chalk.cyan('/models qwen')}                 Search the active provider`,
    `  ${chalk.cyan('/models openrouter:qwen')}      Search OpenRouter models`,
    `  ${chalk.cyan('/models vercel:claude')}        Search Vercel AI Gateway models`,
    '',
    chalk.dim('The browser fetches live models when the selected provider supports it.'),
    chalk.dim('If a provider is not configured yet, run /provider or /login for Anthropic.'),
  ]

  onDone(lines.join('\n'), { display: 'system' })
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmedArgs = args?.trim() || ''

  if (['help', '-h', '--help', '?'].includes(trimmedArgs.toLowerCase())) {
    showHelp(onDone)
    return
  }

  if (trimmedArgs) {
    await showSearchResults(trimmedArgs, onDone)
    return
  }

  return <ModelsPickerWrapper onDone={onDone} setMessages={context.setMessages} />
}
