import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import {
  getClaudeAIOAuthTokens,
  hasAnthropicApiKeyAuth,
  validateProviderAuth,
} from '../utils/auth.js'
import {
  BROWSABLE_MODEL_PROVIDERS,
  getProviderBrowseLabel,
  isVoiceConversationProvider,
  loadProviderModelSections,
  type BrowsableModelProvider,
  type ModelVariantInfo,
  type ModelTag,
  type ProviderModelSection,
  type SectionedModelInfo,
} from '../utils/model/providerCatalog.js'
import {
  getNextOpenAIReasoningLevel,
  getOpenAIReasoningLevel,
  getReasoningLabel,
  modelSupportsReasoning,
  type OpenAIReasoningLevel,
} from '../utils/model/openaiReasoning.js'
import {
  FAVORITE_MARKER,
  getFavoriteModels,
  isFavoriteModel,
  MAX_FAVORITE_MODELS,
  toggleFavoriteModel,
} from '../utils/model/favoriteModels.js'
import { isDirectProvider, isDirectThinkingProvider } from '../utils/model/directProviderCatalog.js'
import { commitProviderEffortSelection, getNextProviderEffort, getProviderEffortPreview } from '../utils/model/providerEffort.js'
import { hasStoredKey } from '../services/api/auth/api_key_manager.js'

type Props = {
  initialProvider: BrowsableModelProvider
  /** `providerEffort` is the native effort chip as the row shows it when it
   * was moved ('auto' or a level), for consumers that apply it themselves. */
  onSelect: (provider: BrowsableModelProvider, modelId: string, effort?: OpenAIReasoningLevel, commitSelection?: () => void, providerEffort?: string) => void
  deferSelectionEffects?: boolean
  onCancel: () => void
  lockedProvider?: BrowsableModelProvider
  /** Model-only consumers must not change OpenAI or native per-model effort. */
  allowOpenAIEffortSelection?: boolean
}

type Step = 'provider' | 'models'

const MAX_VISIBLE_MODELS = 16

/** Raw byte some terminals send for Ctrl+F instead of a decoded key event. */
const CTRL_F_RAW = String.fromCharCode(6)

/** Flattened list entry used for keyboard navigation across sections. */
type FlatRow =
  | { kind: 'header'; sectionId: string; title: string; accent?: ProviderModelSection['accent']; count: number }
  | { kind: 'model'; sectionId: string; model: SectionedModelInfo }

/** Single source of truth for how tags render. */
const TAG_STYLE: Record<ModelTag, { label: string; color: string }> = {
  cloud:     { label: 'cloud',     color: 'magenta' },
  local:     { label: 'local',     color: 'cyan' },
  tools:     { label: 'tools',     color: 'green' },
  'no-tools':{ label: 'no tools',  color: 'yellow' },
  thinking:  { label: 'thinking',  color: 'blue' },
  reasoning: { label: 'reasoning', color: 'blue' },
  recommended: { label: 'RECOMMENDED', color: 'green' },
  free:      { label: 'FREE',      color: 'green' },
  pro:       { label: 'PRO PLAN',  color: 'magenta' },
  'pro-ultra': { label: 'PRO/ULTRA', color: 'magenta' },
  fast:      { label: 'fast',      color: 'cyan' },
  pulled:    { label: 'ready',     color: 'green' },
  missing:   { label: 'pull',      color: 'yellow' },
}

const SECTION_ACCENT: Record<NonNullable<ProviderModelSection['accent']>, string> = {
  cloud: 'magenta',
  local: 'cyan',
  toolless: 'yellow',
}

// With CI set and no key variable, the key lookup throws (it serves `-p` in
// CI). A label only reports what is set up, so that is "no key" here, not a
// crash of the whole provider list.
function hasAnthropicKeyForLabel(): boolean {
  try {
    return hasAnthropicApiKeyAuth()
  } catch {
    return false
  }
}

export function getProviderStatusLabel(provider: BrowsableModelProvider): string {
  if (isVoiceConversationProvider(provider)) {
    return hasStoredKey('openai_oauth') ? 'OpenAI connected' : 'OpenAI OAuth required'
  }

  if (provider === 'firstParty') {
    return getClaudeAIOAuthTokens()?.accessToken || hasAnthropicKeyForLabel()
      ? 'configured'
      : 'optional login'
  }

  const authStatus = validateProviderAuth(provider)
  if ((provider === 'ollama' || provider === 'lmstudio') && authStatus.method === 'none') return 'local'
  if (authStatus.valid) return 'configured'
  return provider === 'ollama' || provider === 'lmstudio' ? 'local' : 'login required'
}

function filterSections(
  sections: readonly ProviderModelSection[],
  query: string,
): ProviderModelSection[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return [...sections]

  return sections
    .map(section => {
      const sectionMatches = section.title.toLowerCase().includes(normalized)
      return {
        ...section,
        models: section.models.filter(model => {
          if (sectionMatches) return true
          const variantHaystack = model.variants
            ?.map(variant => `${variant.id} ${variant.name ?? ''} ${variant.label} ${variant.tags?.join(' ') ?? ''}`)
            .join(' ')
            ?? ''
          const haystack = `${model.id} ${model.name ?? ''} ${model.provider ?? ''} ${model.tags?.join(' ') ?? ''} ${variantHaystack}`.toLowerCase()
          return haystack.includes(normalized)
        }),
      }
    })
    .filter(section => section.models.length > 0)
}

function flattenSections(sections: readonly ProviderModelSection[]): FlatRow[] {
  const rows: FlatRow[] = []
  for (const section of sections) {
    rows.push({
      kind: 'header',
      sectionId: section.id,
      title: section.title,
      accent: section.accent,
      count: section.models.length,
    })
    for (const model of section.models) {
      rows.push({ kind: 'model', sectionId: section.id, model })
    }
  }
  return rows
}

function totalModelCount(sections: readonly ProviderModelSection[]): number {
  return sections.reduce((sum, s) => sum + s.models.length, 0)
}

function firstModelIndex(rows: readonly FlatRow[]): number {
  return rows.findIndex(r => r.kind === 'model')
}

function clampToModel(
  rows: readonly FlatRow[],
  desired: number,
  direction: 1 | -1,
): number {
  if (rows.length === 0) return 0
  let i = desired
  while (i >= 0 && i < rows.length && rows[i]!.kind !== 'model') {
    i += direction
  }
  if (i < 0 || i >= rows.length) {
    // Wrap: pick first/last model
    return direction === 1 ? firstModelIndex(rows) : lastModelIndex(rows)
  }
  return i
}

function lastModelIndex(rows: readonly FlatRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === 'model') return i
  }
  return 0
}

function variantSelectionKey(
  provider: BrowsableModelProvider,
  model: SectionedModelInfo,
): string {
  return `${provider}:${model.id}`
}

function getSelectedVariant(
  provider: BrowsableModelProvider,
  model: SectionedModelInfo,
  variantSelections: Readonly<Record<string, number>>,
): ModelVariantInfo | null {
  const variants = model.variants
  if (!variants || variants.length === 0) return null
  const key = variantSelectionKey(provider, model)
  const selectedIndex = variantSelections[key] ?? getDefaultVariantIndex(model)
  return variants[Math.max(0, Math.min(selectedIndex, variants.length - 1))] ?? variants[0] ?? null
}

function getDefaultVariantIndex(model: SectionedModelInfo): number {
  const variants = model.variants
  if (!variants || variants.length === 0 || !model.defaultVariantId) return 0
  const index = variants.findIndex(variant => variant.id === model.defaultVariantId)
  return index >= 0 ? index : 0
}

function getSelectedModelId(
  provider: BrowsableModelProvider,
  model: SectionedModelInfo,
  variantSelections: Readonly<Record<string, number>>,
): string {
  return getSelectedVariant(provider, model, variantSelections)?.id ?? model.id
}

export function ProviderModelPicker({
  initialProvider,
  onSelect,
  onCancel,
  lockedProvider,
  allowOpenAIEffortSelection = true,
  deferSelectionEffects = false,
}: Props) {
  const [step, setStep] = useState<Step>(lockedProvider ? 'models' : 'provider')
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(() =>
    Math.max(
      0,
      BROWSABLE_MODEL_PROVIDERS.indexOf(lockedProvider ?? initialProvider),
    ),
  )
  const [selectedRowIndex, setSelectedRowIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sections, setSections] = useState<ProviderModelSection[]>([])
  const [openaiEffort, setOpenaiEffort] = useState<OpenAIReasoningLevel>()
  const [providerEffortSelections, setProviderEffortSelections] = useState<Record<string, string>>({})
  const [variantSelections, setVariantSelections] = useState<Record<string, number>>({})
  // Bumped when a favorite is toggled so the ★ column re-renders. The list
  // itself lives in GlobalConfig and is read fresh during render.
  const [favoritesVersion, setFavoritesVersion] = useState(0)
  const [favoriteNotice, setFavoriteNotice] = useState<string | null>(null)
  // The current model only picks which effort chip opens first.
  const mainLoopModel = useAppStateMaybeOutsideOfProvider(s => s.mainLoopModel)
  const appStateEffort = useAppStateMaybeOutsideOfProvider(s => s.effortValue ?? null)
  const displayedOpenaiEffort = openaiEffort ?? appStateEffort

  const selectedProvider =
    lockedProvider
    ?? BROWSABLE_MODEL_PROVIDERS[selectedProviderIndex]
    ?? initialProvider

  useEffect(() => {
    if (step !== 'models') {
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSections([])
    setSelectedRowIndex(0)

    void loadProviderModelSections(selectedProvider, {
      currentModel: mainLoopModel ?? undefined,
    })
      .then(loadedSections => {
        if (cancelled) return

        if (totalModelCount(loadedSections) === 0) {
          setLoadError(
            `No models were returned by ${getProviderBrowseLabel(selectedProvider)}.`,
          )
          return
        }

        setSections(loadedSections)
      })
      .catch(error => {
        if (cancelled) return
        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedProvider, step])

  const filteredSections = useMemo(
    () => filterSections(sections, query),
    [sections, query],
  )

  const flatRows = useMemo(() => flattenSections(filteredSections), [filteredSections])

  // Keep the cursor pointed at a real model row after filters change.
  useEffect(() => {
    if (flatRows.length === 0) {
      setSelectedRowIndex(0)
      return
    }
    if (selectedRowIndex >= flatRows.length || flatRows[selectedRowIndex]?.kind !== 'model') {
      const firstModel = firstModelIndex(flatRows)
      setSelectedRowIndex(firstModel >= 0 ? firstModel : 0)
    }
  }, [flatRows, selectedRowIndex])

  const scrollOffset = useMemo(() => {
    const halfWindow = Math.floor(MAX_VISIBLE_MODELS / 2)
    const start = Math.max(0, selectedRowIndex - halfWindow)
    return Math.min(
      start,
      Math.max(0, flatRows.length - MAX_VISIBLE_MODELS),
    )
  }, [flatRows.length, selectedRowIndex])

  const visibleRows = flatRows.slice(scrollOffset, scrollOffset + MAX_VISIBLE_MODELS)
  const totalMatches = flatRows.filter(r => r.kind === 'model').length
  const favoriteCount = useMemo(
    () => getFavoriteModels().length,
    [favoritesVersion],
  )

  useInput((input, key) => {
    // Any key other than the toggle means the user moved on from the last
    // favorite message.
    if (
      favoriteNotice !== null
      && !((key.ctrl && input === 'f') || input === CTRL_F_RAW)
    ) {
      setFavoriteNotice(null)
    }

    if (key.escape) {
      if (step === 'models') {
        if (lockedProvider) {
          onCancel()
          return
        }

        setStep('provider')
        setQuery('')
        setLoadError(null)
        return
      }

      onCancel()
      return
    }

    if (step === 'provider') {
      if (key.upArrow) {
        setSelectedProviderIndex(index =>
          index > 0 ? index - 1 : BROWSABLE_MODEL_PROVIDERS.length - 1,
        )
        return
      }

      if (key.downArrow) {
        setSelectedProviderIndex(index =>
          index < BROWSABLE_MODEL_PROVIDERS.length - 1 ? index + 1 : 0,
        )
        return
      }

      if (key.return) {
        setStep('models')
      }

      return
    }

    if (loading) {
      return
    }

    if (key.return) {
      const row = flatRows[selectedRowIndex]
      if (row?.kind === 'model') {
        const modelId = getSelectedModelId(selectedProvider, row.model, variantSelections)
        const commitSelection = () => { if (!isVoiceConversationProvider(selectedProvider)) {
          commitProviderEffortSelection(selectedProvider, modelId, providerEffortSelections[`${selectedProvider}:${modelId}`], allowOpenAIEffortSelection)
        } }
        if (!deferSelectionEffects) commitSelection()
        onSelect(
          selectedProvider,
          getSelectedModelId(selectedProvider, row.model, variantSelections),
          selectedProvider === 'openai' ? openaiEffort : undefined,
          deferSelectionEffects ? commitSelection : undefined,
          providerEffortSelections[`${selectedProvider}:${modelId}`],
        )
      }
      return
    }

    // Ctrl+F stars the highlighted model. A bare `f` can't be used here —
    // every printable key goes to the search box below.
    if ((key.ctrl && input === 'f') || input === CTRL_F_RAW) {
      const row = flatRows[selectedRowIndex]
      if (row?.kind !== 'model') return

      if (isVoiceConversationProvider(selectedProvider)) {
        setFavoriteNotice('Voices cannot be favorited')
        return
      }

      const modelId = getSelectedModelId(
        selectedProvider,
        row.model,
        variantSelections,
      )
      const variant = getSelectedVariant(
        selectedProvider,
        row.model,
        variantSelections,
      )
      const result = toggleFavoriteModel(
        selectedProvider,
        modelId,
        variant?.name ?? row.model.name ?? row.model.id,
      )

      if (result.status === 'full') {
        setFavoriteNotice(
          `Favorites are full (${MAX_FAVORITE_MODELS}) — unstar one first`,
        )
        return
      }
      if (result.status === 'invalid') {
        setFavoriteNotice('That model cannot be favorited')
        return
      }

      setFavoriteNotice(
        result.status === 'added'
          ? `${FAVORITE_MARKER} Added ${modelId} to favorites (Alt+P)`
          : `Removed ${modelId} from favorites`,
      )
      setFavoritesVersion(version => version + 1)
      return
    }

    if (key.upArrow) {
      setSelectedRowIndex(index => {
        if (flatRows.length === 0) return 0
        let next = index - 1
        if (next < 0) next = flatRows.length - 1
        return clampToModel(flatRows, next, -1)
      })
      return
    }

    if (key.downArrow) {
      setSelectedRowIndex(index => {
        if (flatRows.length === 0) return 0
        let next = index + 1
        if (next >= flatRows.length) next = 0
        return clampToModel(flatRows, next, 1)
      })
      return
    }

    if (key.pageUp) {
      setSelectedRowIndex(index => {
        if (flatRows.length === 0) return 0
        return clampToModel(flatRows, Math.max(0, index - 10), -1)
      })
      return
    }

    if (key.pageDown) {
      setSelectedRowIndex(index => {
        if (flatRows.length === 0) return 0
        return clampToModel(flatRows, Math.min(flatRows.length - 1, index + 10), 1)
      })
      return
    }

    // Cursor and similar providers own their variants. OpenAI reasoning is
    // intentionally gated to the OpenAI provider so same-named Cursor models
    // never mutate or rely on OpenAI lane state.
    if (key.leftArrow || key.rightArrow) {
      const row = flatRows[selectedRowIndex]
      const variants = row?.kind === 'model' ? row.model.variants : undefined
      if (row?.kind === 'model' && variants && variants.length > 1) {
        const direction = key.leftArrow ? -1 : 1
        setVariantSelections(current => {
          const selectionKey = variantSelectionKey(selectedProvider, row.model)
          const currentIndex = current[selectionKey] ?? getDefaultVariantIndex(row.model)
          const wrapped = (currentIndex + direction + variants.length) % variants.length
          return { ...current, [selectionKey]: wrapped }
        })
        return
      }

      if (
        row?.kind === 'model'
        && selectedProvider === 'openai'
        && allowOpenAIEffortSelection
        && modelSupportsReasoning(row.model.id)
      ) {
        setOpenaiEffort(getNextOpenAIReasoningLevel(
          key.leftArrow ? 'left' : 'right',
          row.model.id,
          displayedOpenaiEffort,
        ))
        return
      }

      if (row?.kind === 'model' && allowOpenAIEffortSelection && !isVoiceConversationProvider(selectedProvider)) {
        const modelId = getSelectedModelId(selectedProvider, row.model, variantSelections)
        const selectionKey = `${selectedProvider}:${modelId}`
        const next = getNextProviderEffort(selectedProvider, modelId, key.leftArrow ? 'left' : 'right', appStateEffort ?? null, providerEffortSelections[selectionKey])
        if (next !== undefined) setProviderEffortSelections(current => ({ ...current, [selectionKey]: next }))
      }
      return
    }

    if (key.backspace || key.delete) {
      setQuery(currentQuery => currentQuery.slice(0, -1))
      setSelectedRowIndex(firstModelIndex(flatRows))
      return
    }

    if (key.tab) {
      return
    }

    if (input && input.length === 1 && input >= ' ') {
      setQuery(currentQuery => currentQuery + input)
      setSelectedRowIndex(firstModelIndex(flatRows))
    }
  })

  if (step === 'provider') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold color="claude">
            Provider Model Browser
          </Text>
        </Box>

        <Text dimColor>
          Pick a provider first. The browser will load that provider's model
          list.
        </Text>

        <Box marginTop={1} flexDirection="column">
          {BROWSABLE_MODEL_PROVIDERS.map((provider, index) => {
            const isSelected = index === selectedProviderIndex
            const status = getProviderStatusLabel(provider)

            return (
              <Box key={provider}>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'claude' : undefined}
                  dimColor={!isSelected}
                >
                  {isSelected ? '> ' : '  '}
                  {getProviderBrowseLabel(provider)}
                </Text>
                <Text dimColor> [{status}]</Text>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            Up/Down to navigate | Enter to load models | Esc to cancel
          </Text>
        </Box>
      </Box>
    )
  }

  const totalRegistered = sections.reduce((sum, s) => sum + s.models.length, 0)
  const itemLabel = isVoiceConversationProvider(selectedProvider) ? 'voices' : 'models'

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          {getProviderBrowseLabel(selectedProvider)}
        </Text>
        {!loading && totalRegistered > 0 && (
          <Text dimColor> ({totalRegistered} {itemLabel})</Text>
        )}
      </Box>

      <Box>
        <Text color="claude">Search: </Text>
        <Text bold>{query}</Text>
        <Text color="claude">_</Text>
        {!loading && !loadError && (
          <Text dimColor>
            {' '}
            ({totalMatches} match{totalMatches === 1 ? '' : 'es'})
          </Text>
        )}
      </Box>

      {loading && (
        <Box marginTop={1} flexDirection="column">
          <Text color="warning">
            Loading {itemLabel} from {getProviderBrowseLabel(selectedProvider)}...
          </Text>
          <Text dimColor>Esc to go back</Text>
        </Box>
      )}

      {!loading && loadError && (
        <Box marginTop={1} flexDirection="column">
          <Text color="error">{loadError}</Text>
          <Text dimColor>
            Run /provider if this provider is not configured yet, or /login for Anthropic.
          </Text>
        </Box>
      )}

      {!loading && !loadError && (
        <Box marginTop={1} flexDirection="column">
          {flatRows.length === 0 ? (
            <Text dimColor>No {itemLabel} match "{query}".</Text>
          ) : (
            visibleRows.map((row, index) => {
              const actualIndex = scrollOffset + index

              if (row.kind === 'header') {
                const accentColor = row.accent ? SECTION_ACCENT[row.accent] : 'claude'
                return (
                  <Box key={`header-${row.sectionId}`} marginTop={actualIndex === 0 ? 0 : 1}>
                    <Text bold color={accentColor}>
                      {`▎ ${row.title}`}
                    </Text>
                    <Text dimColor> ({row.count})</Text>
                  </Box>
                )
              }

              const isSelected = actualIndex === selectedRowIndex
              const { model } = row
              const label =
                model.name && model.name !== model.id
                  ? `${model.id} - ${model.name}`
                  : model.id
              const isStarred =
                !isVoiceConversationProvider(selectedProvider)
                && isFavoriteModel(
                  selectedProvider,
                  getSelectedModelId(selectedProvider, model, variantSelections),
                )
              const isReasoning = allowOpenAIEffortSelection && selectedProvider === 'openai' && modelSupportsReasoning(model.id)
              const selectedModelId = getSelectedModelId(selectedProvider, model, variantSelections)
              const nativeEffort = !isVoiceConversationProvider(selectedProvider)
                ? getProviderEffortPreview(selectedProvider, selectedModelId, appStateEffort ?? null, providerEffortSelections[`${selectedProvider}:${selectedModelId}`])
                : null
              const selectedVariant = getSelectedVariant(
                selectedProvider,
                model,
                variantSelections,
              )
              const canCycleVariant = (model.variants?.length ?? 0) > 1
              const showVariant =
                !!selectedVariant
                && (
                  canCycleVariant
                  || selectedVariant.id !== model.id
                  || (selectedVariant.name != null && selectedVariant.name !== model.name)
                )

              return (
                <Box key={`model-${row.sectionId}-${model.id}`}>
                  <Text
                    bold={isSelected}
                    color={isSelected ? 'claude' : undefined}
                    dimColor={!isSelected}
                  >
                    {isSelected ? '> ' : '  '}
                    {label}
                  </Text>
                  {(isDirectProvider(selectedProvider) || isDirectThinkingProvider(selectedProvider)) && (
                    <Text dimColor>{' '}[{model.contextWindow?.toLocaleString('en-US') ?? 'unknown'} context]</Text>
                  )}
                  {isStarred && (
                    <Text color="yellow" bold={isSelected}>
                      {' '}{FAVORITE_MARKER}
                    </Text>
                  )}
                  {isReasoning && (
                    <Text color={isSelected ? 'cyan' : 'blue'} bold={isSelected}>
                      {' '}◀ {getReasoningLabel(getOpenAIReasoningLevel(model.id, displayedOpenaiEffort))} ▶
                    </Text>
                  )}
                  {nativeEffort?.supported && (
                    <Text color={isSelected ? 'cyan' : 'blue'} bold={isSelected}>
                      {' '}{allowOpenAIEffortSelection ? '◀ ' : '['}{nativeEffort.label}{!nativeEffort.explicit && nativeEffort.value !== undefined && nativeEffort.value !== 'default' ? ' (auto)' : ''}{allowOpenAIEffortSelection ? ' ▶' : ']'}
                    </Text>
                  )}
                  {nativeEffort && !nativeEffort.supported && !showVariant && isSelected && (
                    <Text dimColor>{' '}[{nativeEffort.label}; no effort control]</Text>
                  )}
                  {showVariant && selectedVariant && (
                    <Text color={isSelected ? 'cyan' : 'blue'} bold={isSelected}>
                      {' '}
                      {canCycleVariant ? '◀ ' : '['}
                      {selectedVariant.label}
                      {canCycleVariant ? ' ▶' : ']'}
                    </Text>
                  )}
                  {model.tags && model.tags.length > 0 && (
                    <>
                      {model.tags.filter(t => t !== 'reasoning').map(tag => {
                        const style = TAG_STYLE[tag]
                        return (
                          <Text key={tag} color={style.color}>
                            {' '}[{style.label}]
                          </Text>
                        )
                      })}
                    </>
                  )}
                </Box>
              )
            })
          )}

          {flatRows.length > MAX_VISIBLE_MODELS && (
            <Box marginTop={1}>
              <Text dimColor>
                {scrollOffset > 0 ? '▲' : ' '}
                {' '}
                {scrollOffset + MAX_VISIBLE_MODELS < flatRows.length
                  ? '▼ (scroll for more)'
                  : ''}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {favoriteNotice && (
        <Box marginTop={1}>
          <Text color="yellow">{favoriteNotice}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          Type to filter | ↑/↓ navigate | ←/→ variant/reasoning | Enter select | Esc back
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          Ctrl+F {FAVORITE_MARKER} favorite ({favoriteCount}/{MAX_FAVORITE_MODELS}) — favorites lead the Alt+P picker
        </Text>
      </Box>
    </Box>
  )
}
