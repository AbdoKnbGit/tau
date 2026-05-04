import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
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
  cycleOpenAIReasoningLevel,
  getOpenAIReasoningLevel,
  getReasoningLabel,
  modelSupportsReasoning,
} from '../utils/model/openaiReasoning.js'
import {
  getDeepSeekV4Thinking,
  isDeepSeekV4ThinkingModel,
  toggleDeepSeekV4Thinking,
} from '../utils/model/deepseekThinking.js'
import {
  getVoiceConversationStatus,
  hasVoiceConversationApiKey,
} from '../voice/voiceConversation.js'

type Props = {
  initialProvider: BrowsableModelProvider
  onSelect: (provider: BrowsableModelProvider, modelId: string) => void
  onCancel: () => void
  lockedProvider?: BrowsableModelProvider
}

type Step = 'provider' | 'models'

const MAX_VISIBLE_MODELS = 16

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
  fast:      { label: 'fast',      color: 'cyan' },
  pulled:    { label: 'ready',     color: 'green' },
  missing:   { label: 'pull',      color: 'yellow' },
}

const SECTION_ACCENT: Record<NonNullable<ProviderModelSection['accent']>, string> = {
  cloud: 'magenta',
  local: 'cyan',
  toolless: 'yellow',
}

function getProviderStatusLabel(provider: BrowsableModelProvider): string {
  if (isVoiceConversationProvider(provider)) {
    const status = getVoiceConversationStatus()
    if (status.provider === 'gemini' && hasVoiceConversationApiKey()) {
      return 'configured'
    }
    if (status.provider === 'gemini') return 'needs key'
    return 'local'
  }

  if (provider === 'firstParty') {
    return getClaudeAIOAuthTokens()?.accessToken || hasAnthropicApiKeyAuth()
      ? 'configured'
      : 'optional login'
  }

  const authStatus = validateProviderAuth(provider)
  if (provider === 'ollama' && authStatus.method === 'none') return 'local'
  if (authStatus.valid) return 'configured'
  return provider === 'ollama' ? 'local' : 'login required'
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
  const [reasoningLevel, setReasoningLevel] = useState(getOpenAIReasoningLevel)
  const [deepseekV4Thinking, setDeepseekV4Thinking] = useState(getDeepSeekV4Thinking)
  const [variantSelections, setVariantSelections] = useState<Record<string, number>>({})

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

    void loadProviderModelSections(selectedProvider)
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

  useInput((input, key) => {
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
        onSelect(
          selectedProvider,
          getSelectedModelId(selectedProvider, row.model, variantSelections),
        )
      }
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
        && modelSupportsReasoning(row.model.id)
      ) {
        const newLevel = cycleOpenAIReasoningLevel(key.leftArrow ? 'left' : 'right')
        setReasoningLevel(newLevel)
        return
      }

      if (
        row?.kind === 'model'
        && selectedProvider === 'deepseek'
        && isDeepSeekV4ThinkingModel(row.model.id)
      ) {
        setDeepseekV4Thinking(toggleDeepSeekV4Thinking())
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

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          {getProviderBrowseLabel(selectedProvider)}
        </Text>
        {!loading && totalRegistered > 0 && (
          <Text dimColor> ({totalRegistered} models)</Text>
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
            Fetching models from {getProviderBrowseLabel(selectedProvider)}...
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
            <Text dimColor>No models match "{query}".</Text>
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
              const isReasoning = selectedProvider === 'openai' && modelSupportsReasoning(model.id)
              const isDeepseekV4 = selectedProvider === 'deepseek' && isDeepSeekV4ThinkingModel(model.id)
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
                  {isReasoning && (
                    <Text color={isSelected ? 'cyan' : 'blue'} bold={isSelected}>
                      {' '}◀ {getReasoningLabel(reasoningLevel)} ▶
                    </Text>
                  )}
                  {isDeepseekV4 && (
                    <Text color={isSelected ? 'cyan' : 'blue'} bold={isSelected}>
                      {' '}◀ Thinking {deepseekV4Thinking ? 'ON' : 'OFF'} ▶
                    </Text>
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

      <Box marginTop={1}>
        <Text dimColor>
          Type to filter | ↑/↓ navigate | ←/→ variant/reasoning | Enter select | Esc back
        </Text>
      </Box>
    </Box>
  )
}
