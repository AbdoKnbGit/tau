import * as React from 'react'
import { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import type { OptionWithDescription } from '../../components/CustomSelect/select.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import { modelAcceptsImages } from '../../lanes/shared/vision_capability.js'
import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { authenticatedDescriberProviders } from '../../services/vision/describeImage.js'
import { describerCapableProviders } from '../../services/vision/visionModels.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  loadProviderModels,
  type BrowsableModelProvider,
} from '../../utils/model/providerCatalog.js'
import { PROVIDER_DISPLAY_NAMES } from '../../utils/model/providers.js'

type Props = {
  onDone: (
    result?: string,
    options?: { display?: CommandResultDisplay },
  ) => void
}

const OFF = '__off__'

function displayName(provider: string): string {
  return (
    PROVIDER_DISPLAY_NAMES[provider as keyof typeof PROVIDER_DISPLAY_NAMES] ??
    provider
  )
}

/**
 * Known-vision models first, everything else after.
 *
 * Models are not filtered down to the ones we have vision evidence for. That
 * evidence comes from provider catalogs that do not always carry a modality
 * field, so filtering would hide the exact model someone came here to pick
 * purely because its catalog entry is thin. Badge what we know instead and let
 * the choice be made with eyes open.
 */
function toModelOptions(
  provider: string,
  models: readonly ModelInfo[],
): OptionWithDescription[] {
  const scored = models.map(m => {
    const known =
      m.tags?.includes('vision') === true ||
      modelAcceptsImages(provider, m.id) === true
    return { model: m, known }
  })

  scored.sort((a, b) => Number(b.known) - Number(a.known))

  return scored.map(({ model, known }) => ({
    label: model.name || model.id,
    value: model.id,
    description: known ? 'accepts images' : model.id,
    dimDescription: !known,
  }))
}

function VisionModelPicker({ onDone }: Props): React.ReactNode {
  const configured = authenticatedDescriberProviders()
  const capable = describerCapableProviders(configured)
  const stored = getGlobalConfig().visionModel

  const [provider, setProvider] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!provider) return
    let cancelled = false
    setModels(null)
    setLoadError(null)
    loadProviderModels(provider as BrowsableModelProvider)
      .then(list => {
        if (!cancelled) setModels(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [provider])

  // ── Step 2: model ────────────────────────────────────────────────
  if (provider) {
    if (loadError) {
      return (
        <Pane color="permission">
          <Box flexDirection="column" gap={1}>
            <Text color="red">Could not load models for {displayName(provider)}</Text>
            <Text dimColor>{loadError}</Text>
            <Select
              options={[{ label: 'Back', value: '__back__' }]}
              onChange={() => setProvider(null)}
              onCancel={() => onDone('Vision model unchanged', { display: 'system' })}
            />
          </Box>
        </Pane>
      )
    }

    if (!models) {
      return (
        <Pane color="permission">
          <Text dimColor>Loading {displayName(provider)} models…</Text>
        </Pane>
      )
    }

    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Vision model - {displayName(provider)}</Text>
          <Text dimColor>
            Pick the model that will describe images. Models known to accept
            images are listed first.
          </Text>
          <Select
            options={toModelOptions(provider, models)}
            defaultValue={stored?.provider === provider ? stored.model : undefined}
            onChange={(modelId: string) => {
              saveGlobalConfig(current => ({
                ...current,
                visionModel: { provider, model: modelId },
              }))
              onDone(`Images will be described by ${provider} / ${modelId}`)
            }}
            onCancel={() => setProvider(null)}
          />
        </Box>
      </Pane>
    )
  }

  // ── Step 1: provider ─────────────────────────────────────────────
  const options: OptionWithDescription[] = capable.map(p => ({
    label: displayName(p),
    value: p,
    description:
      stored?.provider === p ? `current: ${stored.model}` : 'choose a model',
    dimDescription: stored?.provider !== p,
  }))

  options.push({
    label: 'Off',
    value: OFF,
    description: 'Never describe images; fall back to OCR text or a marker',
  })

  if (capable.length === 0) {
    return (
      <Pane color="permission">
        <Box flexDirection="column" gap={1}>
          <Text bold>Vision model</Text>
          <Text dimColor>
            None of the providers that can describe images are logged in. Run
            /login and pick Anthropic, OpenAI, Gemini, or Antigravity first.
          </Text>
          <Select
            options={[{ label: 'Close', value: '__close__' }]}
            onChange={() => onDone('Vision model unchanged', { display: 'system' })}
            onCancel={() => onDone('Vision model unchanged', { display: 'system' })}
          />
        </Box>
      </Pane>
    )
  }

  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold>Vision model</Text>
        <Text dimColor>
          Which model describes an image when the model you are coding with
          cannot see one.
        </Text>
        <Select
          options={options}
          defaultValue={stored === null ? OFF : (stored?.provider ?? undefined)}
          onChange={(value: string) => {
            if (value === OFF) {
              saveGlobalConfig(current => ({ ...current, visionModel: null }))
              onDone('Image description turned off')
              return
            }
            setProvider(value)
          }}
          onCancel={() => onDone('Vision model unchanged', { display: 'system' })}
        />
      </Box>
    </Pane>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  return <VisionModelPicker onDone={onDone} />
}
