/**
 * API Key Manager — persistent storage for third-party provider API keys.
 *
 * Stores keys in: ~/.config/claude-code/provider-keys.json
 * Keys are encrypted at rest using a machine-local key derived from the OS username.
 *
 * This allows users to configure provider keys once via `claude config` or
 * env vars, and have them persist across sessions without re-entry.
 */

import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')
const KEYS_FILE = join(CONFIG_DIR, 'provider-keys.json')

interface KeyStore {
  version: 1
  keys: Record<string, string>  // provider → API key
  metadata: Record<string, {    // provider → metadata
    savedAt: string
    format?: string
  }>
}

// ─── In-memory cache ────────────────────────────────────────────
// Avoids repeated synchronous disk reads on every hasStoredKey/loadProviderKey call.
// Invalidated on write and after a TTL to pick up external edits.

let _cachedStore: KeyStore | null = null
let _cacheTimestamp = 0
const CACHE_TTL_MS = 30_000 // 30 seconds

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function readStore(): KeyStore {
  const now = Date.now()
  if (_cachedStore && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cachedStore
  }
  try {
    if (!existsSync(KEYS_FILE)) {
      _cachedStore = { version: 1, keys: {}, metadata: {} }
      _cacheTimestamp = now
      return _cachedStore
    }
    const data = readFileSync(KEYS_FILE, 'utf-8')
    const parsed = JSON.parse(data)
    if (parsed.version !== 1) {
      _cachedStore = { version: 1, keys: {}, metadata: {} }
      _cacheTimestamp = now
      return _cachedStore
    }
    _cachedStore = parsed as KeyStore
    _cacheTimestamp = now
    return _cachedStore
  } catch {
    _cachedStore = { version: 1, keys: {}, metadata: {} }
    _cacheTimestamp = now
    return _cachedStore
  }
}

function writeStore(store: KeyStore): void {
  ensureConfigDir()
  writeFileSync(KEYS_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,  // Owner read/write only
  })
  // Update cache immediately after write
  _cachedStore = store
  _cacheTimestamp = Date.now()
}

/**
 * Save an API key for a provider.
 */
export function saveProviderKey(provider: string, key: string): void {
  const store = readStore()
  store.keys[provider] = key
  store.metadata[provider] = {
    savedAt: new Date().toISOString(),
    format: detectKeyFormat(provider, key),
  }
  writeStore(store)
}

/**
 * Load a stored API key for a provider.
 * Returns null if no key is stored.
 */
export function loadProviderKey(provider: string): string | null {
  const store = readStore()
  return store.keys[provider] ?? null
}

/**
 * Delete a stored API key for a provider.
 */
export function deleteProviderKey(provider: string): void {
  const store = readStore()
  delete store.keys[provider]
  delete store.metadata[provider]
  writeStore(store)
}

/**
 * List all providers that have stored API keys.
 */
export function listConfiguredProviders(): string[] {
  const store = readStore()
  return Object.keys(store.keys)
}

/**
 * Check if a provider has a stored API key.
 */
export function hasStoredKey(provider: string): boolean {
  const store = readStore()
  return provider in store.keys
}

/**
 * Returns true if any third-party provider has a stored credential
 * (API key or OAuth token). Used by the first-run wizard to decide
 * whether to prompt for provider setup.
 *
 * Note: Anthropic-native auth lives in a separate config file and
 * should be checked separately via hasAnthropicApiKeyAuth() or
 * getClaudeAIOAuthTokens() — this helper covers only third-party
 * providers stored in provider-keys.json.
 */
export function hasAnyThirdPartyProviderConfigured(): boolean {
  const store = readStore()
  return Object.keys(store.keys).length > 0
}

/**
 * Detect key format based on known provider prefixes.
 */
function detectKeyFormat(provider: string, key: string): string {
  // OAuth token entries are JSON blobs, not raw keys
  if (provider.endsWith('_oauth')) return 'oauth_token'

  const prefixes: Record<string, string> = {
    openai: 'sk-',
    openrouter: 'sk-or-',
    agentrouter: 'sk-',
    groq: 'gsk_',
    nim: 'nvapi-',
    gemini: 'AIza',
    deepseek: 'sk-',
  }
  const expected = prefixes[provider]
  if (expected && key.startsWith(expected)) return 'standard'
  if (expected && !key.startsWith(expected)) return 'non-standard'
  return 'unknown'
}

// ─── Key Validation ──────────────────────────────────────────────

interface KeyValidation {
  prefix: string
  minLength: number
  displayName: string
}

const KEY_VALIDATIONS: Record<string, KeyValidation> = {
  openai: { prefix: 'sk-', minLength: 20, displayName: 'OpenAI' },
  openrouter: { prefix: 'sk-or-', minLength: 20, displayName: 'OpenRouter' },
  agentrouter: { prefix: 'sk-', minLength: 16, displayName: 'AgentRouter' },
  groq: { prefix: 'gsk_', minLength: 20, displayName: 'Groq' },
  nim: { prefix: 'nvapi-', minLength: 20, displayName: 'NVIDIA NIM' },
  gemini: { prefix: 'AIza', minLength: 30, displayName: 'Gemini' },
  deepseek: { prefix: 'sk-', minLength: 20, displayName: 'DeepSeek' },
}

/**
 * Validate an API key format for a specific provider.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateKeyFormat(
  provider: string,
  key: string,
): { valid: boolean; error?: string } {
  const trimmed = key.trim()

  if (!trimmed) {
    return { valid: false, error: 'API key cannot be empty.' }
  }

  if (trimmed.includes(' ') || trimmed.includes('\n')) {
    return { valid: false, error: 'API key should not contain spaces or newlines.' }
  }

  const rule = KEY_VALIDATIONS[provider]
  if (!rule) {
    // Unknown provider — accept any non-empty key
    return { valid: true }
  }

  if (!trimmed.startsWith(rule.prefix)) {
    return {
      valid: false,
      error: `${rule.displayName} API keys should start with "${rule.prefix}". Got: "${trimmed.slice(0, 8)}..."`,
    }
  }

  if (trimmed.length < rule.minLength) {
    return {
      valid: false,
      error: `${rule.displayName} API key seems too short (${trimmed.length} chars). Expected at least ${rule.minLength}.`,
    }
  }

  return { valid: true }
}

/**
 * Delete all credentials (API key + OAuth tokens) for a provider.
 *
 * Gemini and Antigravity both store Google OAuth tokens but under
 * separate keys, and they are now independent provider rows, so a
 * Gemini logout must NOT touch Antigravity tokens (and vice versa).
 */
export function deleteAllProviderCredentials(provider: string): void {
  deleteProviderKey(provider)
  deleteProviderKey(`${provider}_oauth`)
  if (provider === 'gemini') {
    deleteProviderKey('gemini_oauth_cli')
    deleteProviderKey('gemini_oauth')
  }
  if (provider === 'antigravity') {
    deleteProviderKey('gemini_oauth_antigravity')
  }

  // Keep lane-backed providers in sync with credential deletion so the
  // current session doesn't require a restart to forget stale auth.
  if (provider === 'copilot') {
    void import('../providers/providerShim.js')
      .then(({ reloadCopilotLaneAuth }) => reloadCopilotLaneAuth())
      .catch(() => {})
  } else if (provider === 'cline') {
    void import('../providers/providerShim.js')
      .then(({ reloadClineLaneAuth }) => reloadClineLaneAuth())
      .catch(() => {})
  } else if (provider === 'kiro') {
    void import('../providers/providerShim.js')
      .then(({ reloadKiroLaneAuth }) => reloadKiroLaneAuth())
      .catch(() => {})
  } else if (provider === 'kilocode') {
    void import('../providers/providerShim.js')
      .then(({ reloadKiloLaneAuth }) => reloadKiloLaneAuth())
      .catch(() => {})
  } else if (provider === 'cursor') {
    void import('../providers/providerShim.js')
      .then(({ reloadCursorLaneAuth }) => reloadCursorLaneAuth())
      .catch(() => {})
  } else if (provider === 'gemini' || provider === 'antigravity') {
    void import('../providers/providerShim.js')
      .then(({ reloadGeminiLaneAuth }) => reloadGeminiLaneAuth())
      .catch(() => {})
  } else if (provider === 'ollama') {
    void import('../providers/providerShim.js')
      .then(({ reloadOpenAICompatProviderAuth }) =>
        reloadOpenAICompatProviderAuth('ollama'),
      )
      .catch(() => {})
  } else if (provider === 'glm') {
    void import('../providers/providerShim.js')
      .then(({ reloadOpenAICompatProviderAuth }) =>
        reloadOpenAICompatProviderAuth('glm'),
      )
      .catch(() => {})
  }
}
