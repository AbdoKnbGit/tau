/**
 * Favorite models — a user-curated shortlist for the quick model picker.
 *
 * The Alt+P picker only ever offered the built-in Anthropic tiers, so anyone
 * running several providers had to walk /models → provider → 12+ models just
 * to swap between the two or three they actually use. Favorites pin those to
 * the top of that picker.
 *
 * Each entry carries its provider, so selecting a favorite switches the lane
 * as well as the model — that is the whole point of the list for a session
 * that hops between OpenRouter, Antigravity and DeepSeek.
 *
 * Stored in GlobalConfig rather than settings.json: the list is a personal
 * convenience that should follow the user across every project, and it is
 * mutated from a keypress inside a picker, where a settings-file write would
 * be far too heavy.
 */

import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  getAPIProvider,
  isAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  setActiveProvider,
  type APIProvider,
} from './providers.js'

export type FavoriteModel = {
  provider: APIProvider
  /** Model id exactly as the picker would hand it to the model setter. */
  model: string
  /** Display name captured when the favorite was created. */
  label?: string
}

/** Keeps the quick picker quick — favorites are a shortlist, not a catalog. */
export const MAX_FAVORITE_MODELS = 12

/** Prefix marking a favorite row so it reads as one at a glance. */
export const FAVORITE_MARKER = '★'

/**
 * Select-option value namespace for favorite rows. A favorite is not a plain
 * model string (it carries a provider), so it needs a value the picker can
 * round-trip without colliding with a real model id.
 */
const FAVORITE_OPTION_PREFIX = 'favorite::'

export function favoriteKey(provider: APIProvider, model: string): string {
  return `${provider}::${model}`
}

function isFavoriteEntry(value: unknown): value is FavoriteModel {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.provider === 'string' &&
    isAPIProvider(entry.provider) &&
    typeof entry.model === 'string' &&
    entry.model.trim().length > 0
  )
}

/**
 * Read the saved favorites, dropping anything that no longer parses.
 *
 * The config file is hand-editable and providers come and go between
 * versions, so a stale entry must never break the picker that renders it.
 */
export function getFavoriteModels(): FavoriteModel[] {
  const raw = getGlobalConfig().favoriteModels
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const favorites: FavoriteModel[] = []
  for (const entry of raw) {
    if (!isFavoriteEntry(entry)) continue
    const model = entry.model.trim()
    const key = favoriteKey(entry.provider, model)
    if (seen.has(key)) continue
    seen.add(key)
    favorites.push({
      provider: entry.provider,
      model,
      ...(typeof entry.label === 'string' && entry.label.trim().length > 0
        ? { label: entry.label.trim() }
        : {}),
    })
  }
  return favorites.slice(0, MAX_FAVORITE_MODELS)
}

export function isFavoriteModel(
  provider: APIProvider,
  model: string,
): boolean {
  const key = favoriteKey(provider, model.trim())
  return getFavoriteModels().some(
    favorite => favoriteKey(favorite.provider, favorite.model) === key,
  )
}

export type FavoriteToggleResult =
  | { status: 'added'; favorite: FavoriteModel }
  | { status: 'removed'; favorite: FavoriteModel }
  /** The list is at MAX_FAVORITE_MODELS — remove one before adding another. */
  | { status: 'full' }
  | { status: 'invalid' }

/**
 * Add the model to the favorites, or remove it when it is already there.
 *
 * Newest goes last so the list keeps the order the user built it in; the
 * quick picker renders it verbatim.
 */
export function toggleFavoriteModel(
  provider: APIProvider,
  model: string,
  label?: string,
): FavoriteToggleResult {
  const trimmedModel = model.trim()
  if (!isAPIProvider(provider) || trimmedModel.length === 0) {
    return { status: 'invalid' }
  }

  const key = favoriteKey(provider, trimmedModel)
  const current = getFavoriteModels()
  const existing = current.find(
    favorite => favoriteKey(favorite.provider, favorite.model) === key,
  )

  if (existing) {
    const next = current.filter(
      favorite => favoriteKey(favorite.provider, favorite.model) !== key,
    )
    saveGlobalConfig(config => ({ ...config, favoriteModels: next }))
    return { status: 'removed', favorite: existing }
  }

  if (current.length >= MAX_FAVORITE_MODELS) {
    return { status: 'full' }
  }

  const trimmedLabel = label?.trim()
  const favorite: FavoriteModel = {
    provider,
    model: trimmedModel,
    ...(trimmedLabel && trimmedLabel !== trimmedModel
      ? { label: trimmedLabel }
      : {}),
  }
  saveGlobalConfig(config => ({
    ...config,
    favoriteModels: [...current, favorite],
  }))
  return { status: 'added', favorite }
}

/**
 * Point the session at a favorite's provider and hand back its model id.
 *
 * Only the lane switch happens here. Setting the model stays with the caller,
 * which owns the AppState write and the confirmation message.
 */
export function applyFavoriteModel(favorite: FavoriteModel): string {
  if (getAPIProvider() !== favorite.provider) {
    setActiveProvider(favorite.provider)
  }
  return favorite.model
}

export function favoriteOptionValue(favorite: FavoriteModel): string {
  return `${FAVORITE_OPTION_PREFIX}${favorite.provider}::${favorite.model}`
}

export function isFavoriteOptionValue(value: string): boolean {
  return value.startsWith(FAVORITE_OPTION_PREFIX)
}

/**
 * Resolve a favorite select-option value back to the saved entry, so the
 * caller gets the stored label rather than re-deriving one.
 */
export function parseFavoriteOptionValue(
  value: string,
): FavoriteModel | undefined {
  if (!isFavoriteOptionValue(value)) return undefined

  const rest = value.slice(FAVORITE_OPTION_PREFIX.length)
  const separatorIndex = rest.indexOf('::')
  if (separatorIndex <= 0) return undefined

  const provider = rest.slice(0, separatorIndex)
  const model = rest.slice(separatorIndex + 2)
  if (!isAPIProvider(provider) || model.length === 0) return undefined

  const key = favoriteKey(provider, model)
  return (
    getFavoriteModels().find(
      favorite => favoriteKey(favorite.provider, favorite.model) === key,
    ) ?? { provider, model }
  )
}

export function favoriteDisplayLabel(favorite: FavoriteModel): string {
  return favorite.label ?? favorite.model
}

export function favoriteDescription(favorite: FavoriteModel): string {
  const providerName = PROVIDER_DISPLAY_NAMES[favorite.provider]
  return favorite.label && favorite.label !== favorite.model
    ? `${providerName} · ${favorite.model}`
    : providerName
}
