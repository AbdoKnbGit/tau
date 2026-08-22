/**
 * Favorite models store.
 *
 * Guards the picker contract: toggling is idempotent per (provider, model),
 * favorite option values round-trip back to the entry that produced them, and
 * a hand-edited or stale config never breaks the picker that renders it.
 *
 * Pure logic over GlobalConfig; NODE_ENV=test keeps it in memory.
 */
process.env.NODE_ENV = 'test'

import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import {
  favoriteDescription,
  favoriteDisplayLabel,
  favoriteOptionValue,
  getFavoriteModels,
  isFavoriteModel,
  isFavoriteOptionValue,
  MAX_FAVORITE_MODELS,
  parseFavoriteOptionValue,
  toggleFavoriteModel,
} from './favoriteModels.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    reset()
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: any) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message ?? String(error)}`)
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function reset(): void {
  saveGlobalConfig(config => ({ ...config, favoriteModels: [] }))
}

console.log('favorite models:')

test('toggling adds then removes the same model', () => {
  const added = toggleFavoriteModel('openrouter', 'deepseek/deepseek-v4')
  assert(added.status === 'added', `expected added, got ${added.status}`)
  assert(
    isFavoriteModel('openrouter', 'deepseek/deepseek-v4'),
    'model should be favorited',
  )

  const removed = toggleFavoriteModel('openrouter', 'deepseek/deepseek-v4')
  assert(removed.status === 'removed', `expected removed, got ${removed.status}`)
  assert(
    !isFavoriteModel('openrouter', 'deepseek/deepseek-v4'),
    'model should no longer be favorited',
  )
  assert(getFavoriteModels().length === 0, 'list should be empty again')
})

test('the same model id on two providers are separate favorites', () => {
  toggleFavoriteModel('openrouter', 'gpt-5.4')
  toggleFavoriteModel('openai', 'gpt-5.4')

  assert(getFavoriteModels().length === 2, 'both entries should be kept')
  assert(isFavoriteModel('openai', 'gpt-5.4'), 'openai entry missing')

  toggleFavoriteModel('openai', 'gpt-5.4')
  assert(
    isFavoriteModel('openrouter', 'gpt-5.4'),
    'removing one provider must not remove the other',
  )
})

test('favorites keep insertion order', () => {
  toggleFavoriteModel('deepseek', 'deepseek-v4')
  toggleFavoriteModel('antigravity', 'gemini-3.7-flash')
  toggleFavoriteModel('groq', 'kimi-k2.6')

  const models = getFavoriteModels().map(favorite => favorite.model)
  assert(
    models.join(',') === 'deepseek-v4,gemini-3.7-flash,kimi-k2.6',
    `unexpected order: ${models.join(',')}`,
  )
})

test('the list is capped', () => {
  for (let i = 0; i < MAX_FAVORITE_MODELS; i++) {
    toggleFavoriteModel('openrouter', `model-${i}`)
  }
  assert(
    getFavoriteModels().length === MAX_FAVORITE_MODELS,
    'cap should be reached',
  )

  const overflow = toggleFavoriteModel('openrouter', 'one-too-many')
  assert(overflow.status === 'full', `expected full, got ${overflow.status}`)
  assert(
    !isFavoriteModel('openrouter', 'one-too-many'),
    'over-cap model must not be stored',
  )

  // Removing an existing favorite still works at the cap.
  const removed = toggleFavoriteModel('openrouter', 'model-0')
  assert(removed.status === 'removed', 'removal must work at the cap')
})

test('option values round-trip back to the favorite', () => {
  toggleFavoriteModel('openrouter', 'deepseek/deepseek-v4', 'DeepSeek V4')
  const [favorite] = getFavoriteModels()
  assert(favorite !== undefined, 'favorite was not stored')

  const value = favoriteOptionValue(favorite!)
  assert(isFavoriteOptionValue(value), 'value should be recognized as favorite')

  const parsed = parseFavoriteOptionValue(value)
  assert(parsed?.provider === 'openrouter', 'provider lost in round-trip')
  assert(parsed?.model === 'deepseek/deepseek-v4', 'model lost in round-trip')
  assert(parsed?.label === 'DeepSeek V4', 'label lost in round-trip')
})

test('a plain model id is not mistaken for a favorite value', () => {
  assert(
    !isFavoriteOptionValue('deepseek/deepseek-v4'),
    'plain model id must not look like a favorite value',
  )
  assert(
    parseFavoriteOptionValue('sonnet') === undefined,
    'plain alias must not parse as a favorite',
  )
})

test('a model id containing the separator survives round-trip', () => {
  toggleFavoriteModel('ollama', 'namespace::weird-model')
  const [favorite] = getFavoriteModels()
  const parsed = parseFavoriteOptionValue(favoriteOptionValue(favorite!))
  assert(
    parsed?.model === 'namespace::weird-model',
    `model mangled: ${parsed?.model}`,
  )
})

test('a label equal to the model id is not stored twice', () => {
  toggleFavoriteModel('groq', 'kimi-k2.6', 'kimi-k2.6')
  const [favorite] = getFavoriteModels()
  assert(favorite?.label === undefined, 'redundant label should be dropped')
  assert(
    favoriteDisplayLabel(favorite!) === 'kimi-k2.6',
    'display should fall back to the model id',
  )
  assert(
    favoriteDescription(favorite!) === 'Groq',
    `unexpected description: ${favoriteDescription(favorite!)}`,
  )
})

test('unusable stored entries are ignored', () => {
  saveGlobalConfig(config => ({
    ...config,
    favoriteModels: [
      { provider: 'not-a-provider', model: 'x' },
      { provider: 'openrouter', model: '   ' },
      { provider: 'openrouter' } as never,
      'nonsense' as never,
      { provider: 'openrouter', model: 'deepseek/deepseek-v4' },
      // Duplicate of the entry above.
      { provider: 'openrouter', model: 'deepseek/deepseek-v4' },
    ],
  }))

  const favorites = getFavoriteModels()
  assert(favorites.length === 1, `expected 1 usable entry, got ${favorites.length}`)
  assert(favorites[0]?.provider === 'openrouter', 'wrong entry survived')
})

test('an unset or malformed config key reads as an empty list', () => {
  saveGlobalConfig(config => ({ ...config, favoriteModels: undefined }))
  assert(getGlobalConfig().favoriteModels === undefined, 'key should be unset')
  assert(getFavoriteModels().length === 0, 'unset should read as empty')
  assert(!isFavoriteModel('openrouter', 'anything'), 'nothing is favorited')

  // A hand-edited config can hold anything at all.
  saveGlobalConfig(config => ({ ...config, favoriteModels: 'nope' as never }))
  assert(getFavoriteModels().length === 0, 'non-array should read as empty')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
