import type { ModelInfo } from '../../services/api/providers/base_provider.js'
import { resolveProviderAuth } from '../../services/api/auth/provider_auth.js'
import { getProvider } from '../../services/api/providers/providerShim.js'
import type { EffortLevel } from '../effort.js'
import { validateProviderAuth } from '../auth.js'
import {
  getOllamaCatalog,
  type OllamaCatalog,
  type OllamaModelInfo,
} from './ollamaCatalog.js'
import {
  NIM_PROVIDER_GROUPS,
  type NimModelEntry,
} from './nim_catalog.js'
import {
  SELECTABLE_PROVIDERS,
  type APIProvider,
  PROVIDER_DISPLAY_NAMES,
} from './providers.js'
import { recordProviderModelContextWindows } from './contextWindows.js'
import { modelSupportsReasoning } from './openaiReasoning.js'
import {
  CURSOR_ORDERED_MODEL_GROUPS,
  type CursorModelGroup,
  type CursorModelSection,
  type CursorVariantTag,
} from '../../lanes/cursor/catalog.js'
import { inferProviderLabelFromModelId } from './openrouterCatalog.js'
import {
  VOICE_CONVERSATION_LABEL,
  VOICE_CONVERSATION_MODELS,
  VOICE_CONVERSATION_PROVIDER,
} from '../../voice/voiceConversation.js'

export type BrowsableModelProvider =
  | APIProvider
  | typeof VOICE_CONVERSATION_PROVIDER

export const BROWSABLE_MODEL_PROVIDERS: readonly BrowsableModelProvider[] =
  [...SELECTABLE_PROVIDERS, VOICE_CONVERSATION_PROVIDER]

export function isVoiceConversationProvider(
  provider: BrowsableModelProvider,
): provider is typeof VOICE_CONVERSATION_PROVIDER {
  return provider === VOICE_CONVERSATION_PROVIDER
}

export function getDefaultBrowsableProvider(
  preferredProvider: APIProvider,
): BrowsableModelProvider {
  if (BROWSABLE_MODEL_PROVIDERS.includes(preferredProvider)) {
    return preferredProvider
  }

  return (
    BROWSABLE_MODEL_PROVIDERS.find(provider =>
      !isVoiceConversationProvider(provider) && validateProviderAuth(provider).valid,
    ) ?? 'firstParty'
  )
}

function normalizeProviderQueryToken(
  token: string,
): BrowsableModelProvider | null {
  const normalized = token.trim().toLowerCase()
  const alias: Record<string, BrowsableModelProvider> = {
    anthropic: 'firstParty',
    claude: 'firstParty',
    firstparty: 'firstParty',
    'first-party': 'firstParty',
    voice: VOICE_CONVERSATION_PROVIDER,
    voiceconversation: VOICE_CONVERSATION_PROVIDER,
    'voice-conversation': VOICE_CONVERSATION_PROVIDER,
    geminivoice: VOICE_CONVERSATION_PROVIDER,
    'gemini-voice': VOICE_CONVERSATION_PROVIDER,
    gemini_voice: VOICE_CONVERSATION_PROVIDER,
  }
  if (alias[normalized]) {
    return alias[normalized]
  }
  return (
    BROWSABLE_MODEL_PROVIDERS.find(
      provider => provider.toLowerCase() === normalized,
    ) ?? null
  )
}

export function parseProviderModelQuery(
  rawArgs: string,
  fallbackProvider: BrowsableModelProvider,
): { provider: BrowsableModelProvider; query: string } {
  const args = rawArgs.trim()
  if (!args) {
    return { provider: fallbackProvider, query: '' }
  }

  const colonIndex = args.indexOf(':')
  if (colonIndex > 0) {
    const providerCandidate = normalizeProviderQueryToken(
      args.slice(0, colonIndex),
    )
    if (providerCandidate) {
      return {
        provider: providerCandidate,
        query: args.slice(colonIndex + 1).trim(),
      }
    }
  }

  const [firstToken, ...rest] = args.split(/\s+/)
  const providerCandidate = firstToken
    ? normalizeProviderQueryToken(firstToken)
    : null
  if (providerCandidate) {
    return {
      provider: providerCandidate,
      query: rest.join(' ').trim(),
    }
  }

  return { provider: fallbackProvider, query: args }
}

export async function loadProviderModels(
  provider: BrowsableModelProvider,
): Promise<ModelInfo[]> {
  if (isVoiceConversationProvider(provider)) {
    return VOICE_CONVERSATION_MODELS.map(model => ({
      id: model.id,
      name: model.name,
      tags: model.tags,
      provider: VOICE_CONVERSATION_LABEL,
    }))
  }

  if (provider === 'firstParty') {
    const models = ANTHROPIC_MODELS.map(model => ({
      id: model.id,
      name: model.name,
      tags: model.tags,
      contextWindow: model.contextWindow,
    }))
    recordProviderModelContextWindows(provider, models)
    return models
  }

  await resolveProviderAuth(provider)

  const models = await getProvider(provider).listModels()
  recordProviderModelContextWindows(provider, models)
  if (provider === 'cursor' || provider === 'cline') {
    // Cursor's native picker order is provider-owned and should not be
    // alphabetized away; the ids intentionally mirror Cursor's own model surface.
    // Cline also returns a curated, provider-owned order.
    return models
  }
  if (provider === 'openrouter' || provider === 'nim') {
    return sortProviderModels(
      models.map(model => enrichUpstreamProviderModel(provider, model)),
    )
  }
  return sortProviderModels(models)
}

/**
 * A sectioned section of models to render inside the picker. Sections are
 * header-labelled groups with optional capability badges on each row.
 */
export interface ProviderModelSection {
  id: string
  title: string
  accent?: 'cloud' | 'local' | 'toolless'
  models: SectionedModelInfo[]
}

export interface SectionedModelInfo extends ModelInfo {
  /** Optional tags to render beside the model name (tools, thinking, etc). */
  tags?: readonly ModelTag[]
  /**
   * Provider-owned concrete variants for this display row. Cursor uses this
   * to keep thinking/high variants separate from OpenAI's reasoning setting.
   */
  variants?: readonly ModelVariantInfo[]
  /** Optional provider-owned default variant id for picker initialization. */
  defaultVariantId?: string
  /** True when the model requires an extra pull/auth step before use. */
  needsPull?: boolean
}

export interface ModelVariantInfo extends ModelInfo {
  label: string
  tags?: readonly ModelTag[]
}

export type ModelTag =
  | 'cloud'
  | 'local'
  | 'tools'
  | 'no-tools'
  | 'thinking'
  | 'reasoning'
  | 'recommended'
  | 'free'
  | 'pro'
  | 'fast'
  | 'pulled'
  | 'missing'

type AnthropicModelInfo = {
  id: string
  name: string
  tags: readonly ModelTag[]
  effortLevels?: readonly EffortLevel[]
  defaultEffort?: EffortLevel
  contextWindow?: number
}

const ANTHROPIC_EFFORT_SEPARATOR = '::effort='
const ANTHROPIC_STANDARD_EFFORTS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]
const ANTHROPIC_OPUS_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

const ANTHROPIC_MODELS: readonly AnthropicModelInfo[] = [
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    tags: ['recommended', 'reasoning'],
    effortLevels: ANTHROPIC_OPUS_EFFORTS,
    defaultEffort: 'medium',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    tags: ['reasoning'],
    effortLevels: ANTHROPIC_STANDARD_EFFORTS,
    defaultEffort: 'high',
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    tags: ['fast'],
  },
]

export type ProviderModelSelection = {
  modelId: string
  effort?: EffortLevel
}

function encodeAnthropicEffortVariant(
  modelId: string,
  effort: EffortLevel,
): string {
  return `${modelId}${ANTHROPIC_EFFORT_SEPARATOR}${effort}`
}

function isAnthropicEffortLevel(value: string): value is EffortLevel {
  return (ANTHROPIC_OPUS_EFFORTS as readonly string[]).includes(value)
}

export function resolveProviderModelSelection(
  provider: BrowsableModelProvider,
  selectedModelId: string,
): ProviderModelSelection {
  if (provider !== 'firstParty') {
    return { modelId: selectedModelId }
  }

  const markerIndex = selectedModelId.lastIndexOf(ANTHROPIC_EFFORT_SEPARATOR)
  if (markerIndex < 0) {
    return { modelId: selectedModelId }
  }

  const modelId = selectedModelId.slice(0, markerIndex)
  const effort = selectedModelId.slice(
    markerIndex + ANTHROPIC_EFFORT_SEPARATOR.length,
  )
  if (!modelId || !isAnthropicEffortLevel(effort)) {
    return { modelId: selectedModelId }
  }
  const model = ANTHROPIC_MODELS.find(candidate => candidate.id === modelId)
  if (!model?.effortLevels?.includes(effort)) {
    return { modelId }
  }
  return { modelId, effort }
}

/**
 * Load a provider's models split into sections. Ollama splits by local/cloud,
 * OpenRouter and NIM split by upstream provider, and OpenAI splits reasoning
 * models from the rest.
 */
export async function loadProviderModelSections(
  provider: BrowsableModelProvider,
): Promise<ProviderModelSection[]> {
  if (isVoiceConversationProvider(provider)) {
    return [
      {
        id: 'voice-conversation',
        title: VOICE_CONVERSATION_LABEL,
        accent: 'cloud',
        models: VOICE_CONVERSATION_MODELS.map(model => ({
          id: model.id,
          name: model.name,
          tags: model.tags.filter(isModelTag),
          provider: VOICE_CONVERSATION_LABEL,
        })),
      },
    ]
  }

  if (provider === 'firstParty') {
    return buildAnthropicSections()
  }

  if (provider === 'ollama') {
    const catalog = await getOllamaCatalog()
    return buildOllamaSections(catalog)
  }

  if (provider === 'cursor') {
    await resolveProviderAuth(provider)
    return buildCursorSections()
  }

  const models = await loadProviderModels(provider)

  if (provider === 'openrouter' || provider === 'nim') {
    return buildUpstreamProviderSections(provider, models)
  }

  // For OpenAI: split into Codex (reasoning) and other models.
  if (provider === 'openai') {
    const codex: SectionedModelInfo[] = []
    const other: SectionedModelInfo[] = []
    for (const m of models) {
      const tags = mergeModelTags(
        pickKnownModelTags(m),
        modelSupportsReasoning(m.id) ? ['reasoning'] : undefined,
      )
      const entry: SectionedModelInfo = { ...m, tags: tags.length > 0 ? tags : undefined }
      if (modelSupportsReasoning(m.id)) {
        codex.push(entry)
      } else {
        other.push(entry)
      }
    }
    const sections: ProviderModelSection[] = []
    if (codex.length > 0) {
      sections.push({ id: 'codex', title: 'Codex models  ← → reasoning level', models: codex })
    }
    if (other.length > 0) {
      sections.push({ id: 'other', title: 'Other models', models: other })
    }
    return sections.length > 0 ? sections : [{ id: 'all', title: 'OpenAI models', models: models.map(m => ({ ...m })) }]
  }

  return [
    {
      id: 'all',
      title: `${getProviderBrowseLabel(provider)} models`,
      models: models.map(toProviderSectionedModel),
    },
  ]
}

const CURSOR_SECTION_ORDER: readonly CursorModelSection[] = [
  'recommended',
  'cursor',
  'openai',
  'anthropic',
  'other',
]

const CURSOR_SECTION_TITLES: Record<CursorModelSection, string> = {
  recommended: 'Auto',
  cursor: 'Cursor',
  anthropic: 'Claude',
  openai: 'OpenAI / Codex',
  other: 'Others',
}

function buildAnthropicSections(): ProviderModelSection[] {
  return [
    {
      id: 'claude',
      title: 'Claude models  <- -> effort',
      models: ANTHROPIC_MODELS.map(toAnthropicSectionedModel),
    },
  ]
}

function toAnthropicSectionedModel(model: AnthropicModelInfo): SectionedModelInfo {
  const base: SectionedModelInfo = {
    id: model.id,
    name: model.name,
    tags: model.tags,
  }

  if (!model.effortLevels || !model.defaultEffort) {
    return base
  }

  return {
    ...base,
    defaultVariantId: encodeAnthropicEffortVariant(
      model.id,
      model.defaultEffort,
    ),
    variants: model.effortLevels.map(effort => ({
      id: encodeAnthropicEffortVariant(model.id, effort),
      name: `${model.name} (${effort} effort)`,
      label: `${effort} effort`,
      tags: ['reasoning'] as const,
    })),
  }
}

function buildCursorSections(): ProviderModelSection[] {
  const buckets: Record<CursorModelSection, SectionedModelInfo[]> = {
    recommended: [],
    cursor: [],
    anthropic: [],
    openai: [],
    other: [],
  }

  for (const group of CURSOR_ORDERED_MODEL_GROUPS) {
    buckets[group.section].push(toCursorSectionedModel(group))
  }

  return CURSOR_SECTION_ORDER
    .map(section => ({
      id: `cursor-${section}`,
      title: CURSOR_SECTION_TITLES[section],
      accent: section === 'openai' ? 'cloud' : undefined,
      models: buckets[section],
    }))
    .filter(section => section.models.length > 0)
}

function toCursorSectionedModel(group: CursorModelGroup): SectionedModelInfo {
  const variants = group.variants.map(variant => ({
    id: variant.id,
    name: variant.name ?? `${group.name} ${variant.label}`,
    label: variant.label,
    tags: variant.tags?.map(toCursorModelTag),
  }))

  const tags = new Set<ModelTag>()
  if (variants.some(variant => variant.tags?.includes('thinking'))) {
    tags.add('thinking')
  }
  if (variants.some(variant => variant.tags?.includes('fast'))) {
    tags.add('fast')
  }

  return {
    id: group.id,
    name: group.name,
    variants,
    ...(group.defaultVariantId ? { defaultVariantId: group.defaultVariantId } : {}),
    tags: tags.size > 0 ? Array.from(tags) : undefined,
  }
}

function toCursorModelTag(tag: CursorVariantTag): ModelTag {
  return tag
}

function buildOllamaSections(catalog: OllamaCatalog): ProviderModelSection[] {
  const sections: ProviderModelSection[] = []

  if (catalog.cloud.length > 0) {
    sections.push({
      id: 'cloud',
      title: 'Cloud models',
      accent: 'cloud',
      models: catalog.cloud.map(toSectionedModel),
    })
  }

  if (catalog.local.length > 0) {
    sections.push({
      id: 'local',
      title: 'Local models',
      accent: 'local',
      models: catalog.local.map(toSectionedModel),
    })
  }

  if (catalog.toolless.length > 0) {
    sections.push({
      id: 'toolless',
      title: 'Local models without tool support',
      accent: 'toolless',
      models: catalog.toolless.map(toSectionedModel),
    })
  }

  return sections
}

function toSectionedModel(model: OllamaModelInfo): SectionedModelInfo {
  const tags: ModelTag[] = []
  tags.push(model.category === 'cloud' ? 'cloud' : 'local')
  tags.push(model.supportsTools ? 'tools' : 'no-tools')
  if (model.supportsThinking) tags.push('thinking')
  if (model.category === 'cloud') {
    tags.push(model.pulled ? 'pulled' : 'missing')
  }

  return {
    id: model.id,
    name: model.name,
    tags,
    needsPull: model.category === 'cloud' && !model.pulled,
  }
}

export function filterProviderModels(
  models: readonly ModelInfo[],
  query: string,
): ModelInfo[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return [...models]
  }

  return models.filter(model => {
    const tags = model.tags?.join(' ') ?? ''
    const provider = model.provider ?? ''
    const haystack = `${model.id} ${model.name ?? ''} ${provider} ${tags}`.toLowerCase()
    return haystack.includes(normalized)
  })
}

export function getProviderBrowseLabel(provider: BrowsableModelProvider): string {
  if (isVoiceConversationProvider(provider)) {
    return VOICE_CONVERSATION_LABEL
  }
  return PROVIDER_DISPLAY_NAMES[provider]
}

function buildUpstreamProviderSections(
  catalogProvider: BrowsableModelProvider,
  models: readonly ModelInfo[],
): ProviderModelSection[] {
  const grouped = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const enriched = enrichUpstreamProviderModel(catalogProvider, model)
    const upstreamProvider = enriched.provider ?? getProviderBrowseLabel(catalogProvider)
    const list = grouped.get(upstreamProvider) ?? []
    list.push(enriched)
    grouped.set(upstreamProvider, list)
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => compareSectionTitles(catalogProvider, left, right))
    .map(([title, sectionModels]) => ({
      id: sectionId(title),
      title,
      models: sortProviderModels(sectionModels).map(toProviderSectionedModel),
    }))
}

function enrichUpstreamProviderModel(
  catalogProvider: BrowsableModelProvider,
  model: ModelInfo,
): ModelInfo {
  if (catalogProvider === 'nim') {
    const catalog = NIM_MODEL_METADATA.get(model.id)
    return {
      ...model,
      name: model.name && model.name !== model.id
        ? model.name
        : catalog?.model.name ?? model.name,
      provider: catalog?.groupName
        ?? model.provider
        ?? inferProviderLabelFromModelId(model.id, getProviderBrowseLabel(catalogProvider)),
    }
  }

  return {
    ...model,
    provider: model.provider
      ?? inferProviderLabelFromModelId(model.id, getProviderBrowseLabel(catalogProvider)),
  }
}

function compareSectionTitles(
  catalogProvider: BrowsableModelProvider,
  left: string,
  right: string,
): number {
  if (catalogProvider === 'nim') {
    const leftOrder = NIM_GROUP_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = NIM_GROUP_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
  }

  return left.localeCompare(right)
}

function sectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'provider'
}

function sortProviderModels(models: readonly ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => {
    const leftProvider = (left.provider ?? '').toLowerCase()
    const rightProvider = (right.provider ?? '').toLowerCase()
    if (leftProvider !== rightProvider) {
      return leftProvider.localeCompare(rightProvider)
    }

    const leftFreeRank = left.tags?.includes('free') ? 0 : 1
    const rightFreeRank = right.tags?.includes('free') ? 0 : 1
    if (leftFreeRank !== rightFreeRank) {
      return leftFreeRank - rightFreeRank
    }

    const leftName = (left.name || left.id).toLowerCase()
    const rightName = (right.name || right.id).toLowerCase()

    if (leftName !== rightName) {
      return leftName.localeCompare(rightName)
    }

    return left.id.localeCompare(right.id)
  })
}

const NIM_MODEL_METADATA = new Map<string, {
  model: NimModelEntry
  groupName: string
}>(
  NIM_PROVIDER_GROUPS.flatMap(group =>
    group.models.map(model => [
      model.id,
      { model, groupName: group.name },
    ] as const),
  ),
)

const NIM_GROUP_ORDER = new Map(
  NIM_PROVIDER_GROUPS.map((group, index) => [group.name, index] as const),
)

const KNOWN_MODEL_TAGS = new Set<ModelTag>([
  'cloud',
  'local',
  'tools',
  'no-tools',
  'thinking',
  'reasoning',
  'recommended',
  'free',
  'pro',
  'fast',
  'pulled',
  'missing',
])

function isModelTag(tag: string): tag is ModelTag {
  return KNOWN_MODEL_TAGS.has(tag as ModelTag)
}

function pickKnownModelTags(model: Pick<ModelInfo, 'tags'>): ModelTag[] | undefined {
  if (!model.tags || model.tags.length === 0) {
    return undefined
  }

  const tags = Array.from(new Set(model.tags.filter(isModelTag)))
  return tags.length > 0 ? tags : undefined
}

function mergeModelTags(
  ...tagGroups: Array<readonly ModelTag[] | undefined>
): ModelTag[] {
  const merged = new Set<ModelTag>()
  for (const group of tagGroups) {
    if (!group) continue
    for (const tag of group) {
      merged.add(tag)
    }
  }
  return Array.from(merged)
}

function toProviderSectionedModel(model: ModelInfo): SectionedModelInfo {
  const tags = pickKnownModelTags(model)
  return {
    ...model,
    ...(tags ? { tags } : {}),
  }
}
