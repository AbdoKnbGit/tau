/**
 * /provider — connect / disconnect AI providers.
 *
 * Two-view state machine:
 *   list       → overview of all manageable providers with auth badges
 *   configure  → per-provider options: Activate OAuth / Activate API Key / Deactivate
 *
 * Core rules (from spec):
 *   - Multiple providers can be connected simultaneously.
 *   - OAuth and API Key on the SAME provider are mutually exclusive —
 *     switching one deactivates the other (mutex is already enforced
 *     inside saveProviderKey / OAuth finish paths, we just call them).
 *   - The user only sees "OpenAI" and "Google Gemini" — CLIProxyAPI /
 *     Antigravity / Codex are implicit engines behind OAuth and never
 *     surface as provider rows.
 *   - OAuth flow is one step: browser opens, user picks account, done.
 *   - API Key flow: prompt → paste → validate → done.
 *
 * This command generally manages credentials. The Anthropic login path also
 * switches routing to firstParty after a successful login.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import chalk from 'chalk'
import { Box, Text, useInput } from '../../ink.js'
import type { CommandResultDisplay } from '../../commands.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  setActiveProvider,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  deleteAllProviderCredentials,
  deleteProviderKey,
  hasStoredKey,
  loadProviderKey,
  saveProviderKey,
  validateKeyFormat,
} from '../../services/api/auth/api_key_manager.js'
import TextInput from '../../components/TextInput.js'
import {
  getClaudeAIOAuthTokens,
  hasAnthropicApiKeyAuth,
} from '../../utils/auth.js'
import { performLogout } from '../logout/logout.js'
import {
  E2BSecurityLogin,
  Login as AnthropicLogin,
} from '../login/login.js'
import { ProviderLoginFlow } from '../../components/ProviderLoginFlow.js'
import {
  GEMINI_VOICE_KEY,
  VOICE_CONVERSATION_LABEL,
  VOICE_CONVERSATION_PROVIDER,
  activateGeminiVoiceConversation,
  clearVoiceConversationCredentials,
  deactivateVoiceConversation,
  getVoiceConversationStatus,
  hasStoredVoiceConversationKey,
  saveVoiceConversationApiKey,
} from '../../voice/voiceConversation.js'
import {
  E2B_SECURITY_DISPLAY_NAME,
  E2B_SECURITY_PROVIDER,
  clearE2BSecurityCredentials,
  formatE2BSecurityBadge,
  hasE2BSecurityAuth,
} from '../../utils/safetest/e2bSecurity.js'

// ─── Config ──────────────────────────────────────────────────────

/**
 * Providers the user can connect via /provider.
 *
 * Anthropic (firstParty) delegates to /login so the OAuth choices stay
 * Tau-compatible.
 *
 * Excluded on purpose:
 *   - bedrock/vertex/foundry  → env/IAM-based, no credentials to manage here
 *
 * Ollama is a special case: no OAuth, no API key — the "credential" is
 * whether the local daemon is reachable at the configured base URL, and
 * the only configurable bit is that base URL.
 *
 * CLIProxyAPI/Antigravity/Codex are implicit engines behind Gemini &
 * OpenAI OAuth — not listed as separate rows.
 */
// `iflow` is hidden from user-facing provider management after the iFlow
// CLI shutdown announcement on April 17, 2026. `modelrouter` is also hidden
// from /provider while its auth/routing code stays wired for compatibility.
const MANAGEABLE_PROVIDERS = [
  // Anthropic surfaces here alongside the third-party providers. The
  // configure view hands Anthropic off to the shared /login OAuth flow
  // (subscription / console / 3rd-party platform) instead of a deactivate
  // prompt, so the credentials path stays Tau-compatible.
  'firstParty',
  'openai',
  'commandcode',
  'gemini',
  'antigravity',
  'openrouter',
  'agentrouter',
  'vercel',
  'requesty',
  'opencode',
  'mistral',
  'nim',
  'deepseek',
  'glm',
  'moonshot',
  'minimax',
  'ollama',
  'lmstudio',
  // Phase 4 (v0.4.0) — 3 full-chat + 3 login-only stubs.
  'kilocode',
  'cline',
  'copilot',
  'kiro',
  'cursor',
] as const satisfies readonly APIProvider[]

const MANAGEABLE_PROVIDER_ROWS = [
  ...MANAGEABLE_PROVIDERS,
  VOICE_CONVERSATION_PROVIDER,
  E2B_SECURITY_PROVIDER,
] as const

type ManageableProvider = (typeof MANAGEABLE_PROVIDER_ROWS)[number]

/** Storage key for the user-supplied Ollama base URL (persisted in provider-keys.json). */
const OLLAMA_BASE_URL_KEY = 'ollama_base_url'
const OLLAMA_DEFAULT_BASE = 'http://localhost:11434'
const LMSTUDIO_BASE_URL_KEY = 'lmstudio_base_url'
const LMSTUDIO_DEFAULT_BASE = 'http://localhost:1234/v1'

type KeyedProvider = Exclude<
  ManageableProvider,
  | 'ollama'
  | 'lmstudio'
  | 'firstParty'
  | typeof VOICE_CONVERSATION_PROVIDER
  | typeof E2B_SECURITY_PROVIDER
>

function getManageableProviderName(provider: ManageableProvider): string {
  if (provider === VOICE_CONVERSATION_PROVIDER) return VOICE_CONVERSATION_LABEL
  if (provider === E2B_SECURITY_PROVIDER) return E2B_SECURITY_DISPLAY_NAME
  return PROVIDER_DISPLAY_NAMES[provider]
}

// ─── Auth state helpers ──────────────────────────────────────────

type AuthState = 'oauth' | 'api_key' | 'inactive'

function getFirstPartyAuthState(): AuthState {
  if (getClaudeAIOAuthTokens()?.accessToken) return 'oauth'
  if (hasAnthropicApiKeyAuth()) return 'api_key'
  return 'inactive'
}

function hasFirstPartyAuth(): boolean {
  return getFirstPartyAuthState() !== 'inactive'
}

function getAuthState(provider: KeyedProvider): AuthState {
  // Gemini row = CLI-tier OAuth (free flash/lite) or AI Studio API key.
  if (provider === 'gemini') {
    if (hasStoredKey('gemini_oauth_cli') || hasStoredKey('gemini_oauth')) return 'oauth'
    if (hasStoredKey('gemini')) return 'api_key'
    return 'inactive'
  }
  // Antigravity row = its own Google-login OAuth pool.
  if (provider === 'antigravity') {
    if (hasStoredKey('gemini_oauth_antigravity')) return 'oauth'
    return 'inactive'
  }
  if (hasStoredKey(`${provider}_oauth`)) return 'oauth'
  if (hasStoredKey(provider)) return 'api_key'
  return 'inactive'
}

/** Detailed Gemini auth state — shows CLI-tier OAuth + AI Studio API key. */
function getGeminiDetailedState(): { cliOAuth: boolean; apiKey: boolean } {
  return {
    cliOAuth: hasStoredKey('gemini_oauth_cli') || hasStoredKey('gemini_oauth'),
    apiKey: hasStoredKey('gemini'),
  }
}

function formatBadge(state: AuthState): string {
  switch (state) {
    case 'oauth':
      return chalk.green('[OAuth ✅]')
    case 'api_key':
      return chalk.green('[API Key ✅]')
    case 'inactive':
      return chalk.dim('[   –   ]')
  }
}

function formatGeminiBadge(): string {
  const { cliOAuth, apiKey } = getGeminiDetailedState()
  const parts: string[] = []
  if (cliOAuth) parts.push('CLI')
  if (apiKey) parts.push('Key')
  if (parts.length === 0) return chalk.dim('[   –   ]')
  return chalk.green(`[${parts.join(' + ')} ✅]`)
}

function formatVoiceConversationBadge(): string {
  const status = getVoiceConversationStatus()
  if (status.provider === 'gemini' && status.keySource) {
    return chalk.green('[Gemini voice key]')
  }
  if (status.provider === 'gemini') {
    return chalk.yellow('[Gemini voice: needs key]')
  }
  return chalk.dim('[Local voice]')
}

// ─── Ollama reachability ──────────────────────────────────────────
//
// Ollama has no credentials — we treat the "state" as whether the
// daemon actually answers. The reachability probe is async so the
// list view holds it in React state and the badge reflects the last
// result.

type OllamaStatus = 'unknown' | 'running' | 'offline'

function getOllamaBaseUrl(): string {
  // Order of precedence matches ollamaCatalog.ts:
  //   OLLAMA_HOST → OLLAMA_BASE_URL → stored override → default.
  // We normalise to a bare origin (no /v1 suffix) because /api/tags
  // lives under the root, not under the OpenAI-compat path.
  const envHost = process.env.OLLAMA_HOST ?? process.env.OLLAMA_BASE_URL
  const stored = loadProviderKey(OLLAMA_BASE_URL_KEY)
  const raw = envHost ?? stored ?? OLLAMA_DEFAULT_BASE
  const withScheme = /^https?:/i.test(raw) ? raw : `http://${raw}`
  return withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

async function probeOllama(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal })
    return res.ok
  } catch {
    return false
  }
}

function formatOllamaBadge(status: OllamaStatus): string {
  switch (status) {
    case 'running':
      return chalk.green('[🟢 Running]')
    case 'offline':
      return chalk.red('[🔴 Offline]')
    case 'unknown':
      return chalk.dim('[   ?    ]')
  }
}

type LmStudioStatus = 'unknown' | 'running' | 'offline'

function normalizeLmStudioBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  const trimmed = withScheme.replace(/\/+$/, '')
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function getLmStudioBaseUrl(): string {
  const raw =
    process.env.LMSTUDIO_BASE_URL
    ?? process.env.LM_STUDIO_BASE_URL
    ?? loadProviderKey(LMSTUDIO_BASE_URL_KEY)
    ?? LMSTUDIO_DEFAULT_BASE
  return normalizeLmStudioBaseUrl(raw)
}

async function probeLmStudio(baseUrl: string, signal?: AbortSignal): Promise<boolean> {
  const rootUrl = normalizeLmStudioBaseUrl(baseUrl).replace(/\/(?:api\/)?v1$/i, '')
  const urls = [
    `${normalizeLmStudioBaseUrl(baseUrl).replace(/\/+$/, '')}/models`,
    `${rootUrl}/api/v1/models`,
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal })
      if (res.ok || res.status === 401 || res.status === 403) {
        return true
      }
    } catch {
      if (signal?.aborted) return false
    }
  }
  return false
}

function formatLmStudioBadge(status: LmStudioStatus): string {
  const active = getAPIProvider() === 'lmstudio' ? `${chalk.green('[Active]')} ` : ''
  switch (status) {
    case 'running':
      return `${active}${chalk.green('[Running]')}`
    case 'offline':
      return `${active}${chalk.red('[Offline]')}`
    case 'unknown':
      return `${active}${chalk.dim('[   ?   ]')}`
  }
}

// ─── View state machine ─────────────────────────────────────────

type View =
  | { kind: 'list'; selectedIndex: number }
  | { kind: 'configure'; provider: ManageableProvider; selectedIndex: number }
  | {
      kind: 'ollama_url_input'
      error?: string
    }
  | {
      kind: 'lmstudio_url_input'
      error?: string
    }
  | {
      kind: 'voice_key_input'
      error?: string
    }
  | { kind: 'provider_login'; provider: KeyedProvider }
  | { kind: 'anthropic_login' }
  | { kind: 'e2b_login' }
  | {
      kind: 'result'
      provider: ManageableProvider
      message: string
      tone: 'success' | 'error'
    }

type ConfigureOption =
  | { kind: 'activate' }
  | { kind: 'login' }
  | { kind: 'deactivate' }
  | { kind: 'set_voice_key' }
  | { kind: 'set_ollama_url' }
  | { kind: 'reset_ollama_url' }
  | { kind: 'test_ollama' }
  | { kind: 'set_lmstudio_url' }
  | { kind: 'reset_lmstudio_url' }
  | { kind: 'test_lmstudio' }
  | { kind: 'back' }

function usesEmbeddedProviderLogin(provider: ManageableProvider): provider is KeyedProvider {
  return (
    provider === 'modelrouter' ||
    provider === 'vercel' ||
    provider === 'requesty' ||
    provider === 'opencode' ||
    provider === 'commandcode'
  )
}

function buildConfigureOptions(
  provider: ManageableProvider,
  ollamaStatus: OllamaStatus,
  lmStudioStatus: LmStudioStatus,
): ConfigureOption[] {
  if (provider === VOICE_CONVERSATION_PROVIDER) {
    const options: ConfigureOption[] = []
    options.push({ kind: 'set_voice_key' })
    if (
      getVoiceConversationStatus().provider === 'gemini' ||
      hasStoredVoiceConversationKey()
    ) {
      options.push({ kind: 'deactivate' })
    }
    options.push({ kind: 'back' })
    return options
  }

  if (provider === E2B_SECURITY_PROVIDER) {
    const options: ConfigureOption[] = []
    options.push({ kind: 'login' })
    if (hasE2BSecurityAuth()) {
      options.push({ kind: 'deactivate' })
    }
    options.push({ kind: 'back' })
    return options
  }

  // Ollama has its own option set.
  if (provider === 'ollama') {
    const options: ConfigureOption[] = []
    options.push({ kind: 'test_ollama' })
    options.push({ kind: 'set_ollama_url' })
    if (hasStoredKey(OLLAMA_BASE_URL_KEY)) {
      options.push({ kind: 'reset_ollama_url' })
    }
    options.push({ kind: 'back' })
    void ollamaStatus
    return options
  }

  if (provider === 'lmstudio') {
    const options: ConfigureOption[] = []
    if (getAPIProvider() !== 'lmstudio') {
      options.push({ kind: 'activate' })
    }
    options.push({ kind: 'test_lmstudio' })
    options.push({ kind: 'set_lmstudio_url' })
    if (hasStoredKey(LMSTUDIO_BASE_URL_KEY)) {
      options.push({ kind: 'reset_lmstudio_url' })
    }
    options.push({ kind: 'back' })
    void lmStudioStatus
    return options
  }

  // Anthropic (firstParty): hand off to the shared /login OAuth flow.
  if (provider === 'firstParty') {
    const options: ConfigureOption[] = []
    options.push({ kind: 'login' })
    if (hasFirstPartyAuth()) {
      options.push({ kind: 'deactivate' })
    }
    options.push({ kind: 'back' })
    return options
  }

  const options: ConfigureOption[] = []

  if (usesEmbeddedProviderLogin(provider)) {
    options.push({ kind: 'login' })
  }

  // Gemini: check CLI-tier OAuth + API key (Antigravity has its own row).
  if (provider === 'gemini') {
    const gemini = getGeminiDetailedState()
    if (gemini.cliOAuth || gemini.apiKey) {
      options.push({ kind: 'deactivate' })
    }
  } else {
    const state = getAuthState(provider)
    if (
      provider === 'agentrouter' &&
      state !== 'inactive' &&
      getAPIProvider() !== 'agentrouter'
    ) {
      options.push({ kind: 'activate' })
    }
    if (state !== 'inactive') {
      options.push({ kind: 'deactivate' })
    }
  }

  options.push({ kind: 'back' })
  return options
}

function labelConfigureOption(
  option: ConfigureOption,
  provider: ManageableProvider,
): string {
  switch (option.kind) {
    case 'activate':
      return provider === 'agentrouter'
        ? 'Activate AgentRouter'
        : `Activate ${getManageableProviderName(provider)}`
    case 'login':
      return provider === 'firstParty'
        ? 'Log in with Anthropic (subscription / Console API / platform)'
        : provider === E2B_SECURITY_PROVIDER
        ? 'Log in with E2B API key or auth token'
        : 'Log in'
    case 'deactivate':
      return provider === VOICE_CONVERSATION_PROVIDER
        ? 'Deactivate voice conversation'
        : provider === E2B_SECURITY_PROVIDER
        ? 'Clear E2B credentials'
        : 'Deactivate (clear all credentials)'
    case 'set_voice_key':
      return 'Set Gemini voice API key'
    case 'set_ollama_url':
      return 'Set custom base URL'
    case 'reset_ollama_url':
      return 'Reset base URL to default (http://localhost:11434)'
    case 'test_ollama':
      return 'Test connection'
    case 'set_lmstudio_url':
      return 'Set custom base URL'
    case 'reset_lmstudio_url':
      return 'Reset base URL to default (http://localhost:1234/v1)'
    case 'test_lmstudio':
      return 'Test connection'
    case 'back':
      return '← Back to provider list'
  }
}

// ─── Component ──────────────────────────────────────────────────

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function ProviderManager({
  onDone,
  setMessages,
}: {
  onDone: OnDone
  setMessages: LocalJSXCommandContext['setMessages']
}) {
  const [view, setView] = useState<View>({ kind: 'list', selectedIndex: 0 })
  // Refresh tick forces re-read of auth state after saves/deletes.
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = () => setRefreshTick(t => t + 1)

  const [ollamaUrlInput, setOllamaUrlInput] = useState('')
  const [ollamaUrlCursorOffset, setOllamaUrlCursorOffset] = useState(0)
  const [lmStudioUrlInput, setLmStudioUrlInput] = useState('')
  const [lmStudioUrlCursorOffset, setLmStudioUrlCursorOffset] = useState(0)
  const [voiceKeyInput, setVoiceKeyInput] = useState('')
  const [voiceKeyCursorOffset, setVoiceKeyCursorOffset] = useState(0)
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 14)

  // Live reachability status for Ollama, computed when we first render
  // the list or configure view and refreshed when the user asks for it.
  // The badge starts at "unknown" and flips after the probe resolves.
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('unknown')
  const [lmStudioStatus, setLmStudioStatus] = useState<LmStudioStatus>('unknown')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    setOllamaStatus('unknown')
    probeOllama(getOllamaBaseUrl(), controller.signal).then(ok => {
      if (cancelled) return
      setOllamaStatus(ok ? 'running' : 'offline')
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [refreshTick])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    setLmStudioStatus('unknown')
    probeLmStudio(getLmStudioBaseUrl(), controller.signal).then(ok => {
      if (cancelled) return
      setLmStudioStatus(ok ? 'running' : 'offline')
    })
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [refreshTick])

  // ─── Handlers ─────────────────────────────────────────────────

  function enterConfigure(provider: ManageableProvider) {
    setView({ kind: 'configure', provider, selectedIndex: 0 })
  }

  function backToList() {
    // Preserve the list selection on the provider the user just configured.
    const lastProvider =
      view.kind === 'configure' || view.kind === 'result'
        ? view.provider
        : undefined
    const idx = lastProvider ? MANAGEABLE_PROVIDER_ROWS.indexOf(lastProvider) : 0
    setView({ kind: 'list', selectedIndex: idx >= 0 ? idx : 0 })
  }

  function handleDeactivate(provider: KeyedProvider) {
    deleteAllProviderCredentials(provider)
    if (provider === 'gemini') {
      // Gemini row = CLI-tier only; Antigravity has its own row.
      deleteProviderKey('gemini_oauth_cli')
      deleteProviderKey('gemini_oauth')
    }
    if (provider === 'antigravity') {
      deleteProviderKey('gemini_oauth_antigravity')
    }
    refresh()
    setView({
      kind: 'result',
      provider,
      tone: 'success',
      message: `${getManageableProviderName(provider)} disconnected.`,
    })
  }

  function handleActivateAgentRouter() {
    setActiveProvider('agentrouter')
    setMessages(stripSignatureBlocks)
    refresh()
    setView({
      kind: 'result',
      provider: 'agentrouter',
      tone: 'success',
      message: 'AgentRouter activated.',
    })
  }

  function handleActivateLmStudio() {
    setActiveProvider('lmstudio')
    refresh()
    setView({
      kind: 'result',
      provider: 'lmstudio',
      tone: 'success',
      message: 'LM Studio activated.',
    })
  }

  function handleVoiceKeySubmit(value: string) {
    const key = value.trim()
    if (!key) {
      setView({
        kind: 'voice_key_input',
        error: 'API key cannot be empty.',
      })
      return
    }

    saveVoiceConversationApiKey(key)
    const result = activateGeminiVoiceConversation()
    if (result.error) {
      setView({
        kind: 'voice_key_input',
        error:
          'Key saved, but Tau could not update settings. Check your settings file for syntax errors.',
      })
      return
    }

    setVoiceKeyInput('')
    setVoiceKeyCursorOffset(0)
    refresh()
    const formatCheck = validateKeyFormat('gemini', key)
    const warning =
      !formatCheck.valid && formatCheck.error
        ? ` Warning: ${formatCheck.error}`
        : ''
    setView({
      kind: 'result',
      provider: VOICE_CONVERSATION_PROVIDER,
      tone: formatCheck.valid ? 'success' : 'error',
      message: `Gemini voice key saved and activated.${warning}`,
    })
  }

  function handleVoiceDeactivate() {
    clearVoiceConversationCredentials()
    const result = deactivateVoiceConversation()
    refresh()
    setView({
      kind: 'result',
      provider: VOICE_CONVERSATION_PROVIDER,
      tone: result.error ? 'error' : 'success',
      message: result.error
        ? 'Voice credentials were cleared, but Tau could not update settings.'
        : 'Voice conversation switched to local speech tools.',
    })
  }

  // ─── Anthropic (firstParty) handlers ──────────────────────────

  function handleAnthropicLoginDone(success: boolean) {
    if (success) {
      setActiveProvider('firstParty')
      // Strip any thinking-block signatures bound to the previously-active
      // provider so the next turn doesn't 400 with "Invalid signature".
      setMessages(stripSignatureBlocks)
      refresh()
      setView({
        kind: 'result',
        provider: 'firstParty',
        tone: 'success',
        message: `${PROVIDER_DISPLAY_NAMES.firstParty} connected.`,
      })
      return
    }
    // Cancelled: return to the Anthropic configure screen.
    setView({ kind: 'configure', provider: 'firstParty', selectedIndex: 0 })
  }

  function handleAnthropicDeactivate() {
    void performLogout({ provider: 'firstParty' }).finally(() => {
      refresh()
      setView({
        kind: 'result',
        provider: 'firstParty',
        tone: 'success',
        message: `${PROVIDER_DISPLAY_NAMES.firstParty} disconnected.`,
      })
    })
  }

  function handleE2BLoginDone(success: boolean) {
    if (success) {
      refresh()
      setView({
        kind: 'result',
        provider: E2B_SECURITY_PROVIDER,
        tone: 'success',
        message: `${E2B_SECURITY_DISPLAY_NAME} connected.`,
      })
      return
    }
    setView({
      kind: 'configure',
      provider: E2B_SECURITY_PROVIDER,
      selectedIndex: 0,
    })
  }

  function handleE2BDeactivate() {
    clearE2BSecurityCredentials()
    refresh()
    setView({
      kind: 'result',
      provider: E2B_SECURITY_PROVIDER,
      tone: 'success',
      message: `${E2B_SECURITY_DISPLAY_NAME} credentials cleared.`,
    })
  }

  // ─── Ollama handlers ──────────────────────────────────────────

  function handleTestOllama() {
    // Refreshing forces the reachability effect to re-run.
    setOllamaStatus('unknown')
    refresh()
  }

  function handleOllamaUrlSubmit(value: string) {
    const raw = value.trim()
    if (!raw) return

    // Accept either a full URL or a host:port shorthand, matching
    // ollamaCatalog.ts's ollamaBase().
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    try {
      const parsed = new URL(withScheme)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad protocol')
      }
    } catch {
      setView({
        kind: 'ollama_url_input',
        error: 'Not a valid URL. Try "http://localhost:11434" or "my-box:11434".',
      })
      return
    }

    const normalised = withScheme.replace(/\/+$/, '').replace(/\/v1$/i, '')
    saveProviderKey(OLLAMA_BASE_URL_KEY, normalised)
    process.env.OLLAMA_BASE_URL = normalised

    setOllamaUrlInput('')
    setOllamaUrlCursorOffset(0)
    setOllamaStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'ollama',
      tone: 'success',
      message: `Ollama base URL set to ${normalised}. Testing connection…`,
    })
  }

  function handleResetOllamaUrl() {
    deleteProviderKey(OLLAMA_BASE_URL_KEY)
    // Clear the env override too, so we fall back to the default.
    delete process.env.OLLAMA_BASE_URL
    delete process.env.OLLAMA_HOST
    setOllamaStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'ollama',
      tone: 'success',
      message: `Ollama base URL reset to ${OLLAMA_DEFAULT_BASE}.`,
    })
  }

  function reloadLmStudioInRuntime() {
    void import('../../services/api/providers/providerShim.js')
      .then(({ reloadOpenAICompatProviderAuth }) =>
        reloadOpenAICompatProviderAuth('lmstudio'),
      )
      .catch(() => {})
  }

  function handleTestLmStudio() {
    setLmStudioStatus('unknown')
    refresh()
  }

  function handleLmStudioUrlSubmit(value: string) {
    const raw = value.trim()
    if (!raw) return

    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    try {
      const parsed = new URL(withScheme)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('bad protocol')
      }
    } catch {
      setView({
        kind: 'lmstudio_url_input',
        error: 'Not a valid URL. Try "http://localhost:1234/v1" or "my-box:1234".',
      })
      return
    }

    const normalised = normalizeLmStudioBaseUrl(withScheme)
    saveProviderKey(LMSTUDIO_BASE_URL_KEY, normalised)
    process.env.LMSTUDIO_BASE_URL = normalised
    delete process.env.LM_STUDIO_BASE_URL
    reloadLmStudioInRuntime()

    setLmStudioUrlInput('')
    setLmStudioUrlCursorOffset(0)
    setLmStudioStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'lmstudio',
      tone: 'success',
      message: `LM Studio base URL set to ${normalised}. Testing connection...`,
    })
  }

  function handleResetLmStudioUrl() {
    deleteProviderKey(LMSTUDIO_BASE_URL_KEY)
    delete process.env.LMSTUDIO_BASE_URL
    delete process.env.LM_STUDIO_BASE_URL
    reloadLmStudioInRuntime()
    setLmStudioStatus('unknown')
    refresh()
    setView({
      kind: 'result',
      provider: 'lmstudio',
      tone: 'success',
      message: `LM Studio base URL reset to ${LMSTUDIO_DEFAULT_BASE}.`,
    })
  }

  // ─── Input routing ────────────────────────────────────────────

  useInput((input: string, key: {
    upArrow?: boolean
    downArrow?: boolean
    return?: boolean
    escape?: boolean
  }) => {
    // Global: Esc cancels the whole flow from any non-input view.
    // TextInput-backed views handle their own Esc.
    if (
      key.escape &&
      view.kind !== 'ollama_url_input' &&
      view.kind !== 'lmstudio_url_input' &&
      view.kind !== 'voice_key_input'
    ) {
      if (view.kind === 'list') {
        onDone('Provider setup closed.', { display: 'system' })
        return
      }
      backToList()
      return
    }

    // ollama_url_input: Esc goes back to the ollama configure screen.
    if (view.kind === 'ollama_url_input' && key.escape) {
      setOllamaUrlInput('')
      setOllamaUrlCursorOffset(0)
      setView({ kind: 'configure', provider: 'ollama', selectedIndex: 0 })
      return
    }

    if (view.kind === 'lmstudio_url_input' && key.escape) {
      setLmStudioUrlInput('')
      setLmStudioUrlCursorOffset(0)
      setView({ kind: 'configure', provider: 'lmstudio', selectedIndex: 0 })
      return
    }

    if (view.kind === 'voice_key_input' && key.escape) {
      setVoiceKeyInput('')
      setVoiceKeyCursorOffset(0)
      setView({
        kind: 'configure',
        provider: VOICE_CONVERSATION_PROVIDER,
        selectedIndex: 0,
      })
      return
    }

    // ─── list view ───
    if (view.kind === 'list') {
      if (key.upArrow) {
        setView({
          kind: 'list',
          selectedIndex:
            view.selectedIndex > 0
              ? view.selectedIndex - 1
              : MANAGEABLE_PROVIDER_ROWS.length - 1,
        })
        return
      }
      if (key.downArrow) {
        setView({
          kind: 'list',
          selectedIndex:
            view.selectedIndex < MANAGEABLE_PROVIDER_ROWS.length - 1
              ? view.selectedIndex + 1
              : 0,
        })
        return
      }
      if (key.return) {
        const provider = MANAGEABLE_PROVIDER_ROWS[view.selectedIndex]
        if (provider) enterConfigure(provider)
        return
      }
      return
    }

    // ─── configure view ───
    if (view.kind === 'configure') {
      const options = buildConfigureOptions(view.provider, ollamaStatus, lmStudioStatus)
      if (key.upArrow) {
        setView({
          ...view,
          selectedIndex:
            view.selectedIndex > 0
              ? view.selectedIndex - 1
              : options.length - 1,
        })
        return
      }
      if (key.downArrow) {
        setView({
          ...view,
          selectedIndex:
            view.selectedIndex < options.length - 1
              ? view.selectedIndex + 1
              : 0,
        })
        return
      }
      if (key.return) {
        const chosen = options[view.selectedIndex]
        if (!chosen) return
        switch (chosen.kind) {
          case 'activate':
            if (view.provider === 'agentrouter') {
              handleActivateAgentRouter()
            }
            if (view.provider === 'lmstudio') {
              handleActivateLmStudio()
            }
            return
          case 'login':
            if (view.provider === 'firstParty') {
              setView({ kind: 'anthropic_login' })
            }
            if (view.provider === E2B_SECURITY_PROVIDER) {
              setView({ kind: 'e2b_login' })
            }
            if (usesEmbeddedProviderLogin(view.provider)) {
              setView({ kind: 'provider_login', provider: view.provider })
            }
            return
          case 'deactivate':
            if (view.provider === 'firstParty') {
              handleAnthropicDeactivate()
              return
            }
            if (view.provider === VOICE_CONVERSATION_PROVIDER) {
              handleVoiceDeactivate()
              return
            }
            if (view.provider === E2B_SECURITY_PROVIDER) {
              handleE2BDeactivate()
              return
            }
            if (view.provider !== 'ollama' && view.provider !== 'lmstudio') {
              handleDeactivate(view.provider)
            }
            return
          case 'set_voice_key':
            setVoiceKeyInput('')
            setVoiceKeyCursorOffset(0)
            setView({ kind: 'voice_key_input' })
            return
          case 'set_ollama_url':
            setOllamaUrlInput('')
            setOllamaUrlCursorOffset(0)
            setView({ kind: 'ollama_url_input' })
            return
          case 'reset_ollama_url':
            handleResetOllamaUrl()
            return
          case 'test_ollama':
            handleTestOllama()
            return
          case 'set_lmstudio_url':
            setLmStudioUrlInput('')
            setLmStudioUrlCursorOffset(0)
            setView({ kind: 'lmstudio_url_input' })
            return
          case 'reset_lmstudio_url':
            handleResetLmStudioUrl()
            return
          case 'test_lmstudio':
            handleTestLmStudio()
            return
          case 'back':
            backToList()
            return
        }
      }
      return
    }

    // ─── result view ───
    if (view.kind === 'result') {
      if (key.return) backToList()
      return
    }
  })

  // ─── Render ───────────────────────────────────────────────────

  const header = (
    <Box marginBottom={1}>
      <Text bold color="claude">
        🔌 Providers
      </Text>
    </Box>
  )

  if (view.kind === 'list') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text dimColor>
          Connect the AI accounts you want Tau to use. Multiple providers
          can be active at once.
        </Text>
        <Box marginTop={1} flexDirection="column">
          {MANAGEABLE_PROVIDER_ROWS.map((provider, i) => {
            const isSelected = i === view.selectedIndex
            const name = getManageableProviderName(provider)
            const prefix = isSelected ? '>' : ' '
            const badge =
              provider === VOICE_CONVERSATION_PROVIDER
                ? formatVoiceConversationBadge()
                : provider === E2B_SECURITY_PROVIDER
                ? chalk.green(formatE2BSecurityBadge())
                : provider === 'ollama'
                ? formatOllamaBadge(ollamaStatus)
                : provider === 'lmstudio'
                ? formatLmStudioBadge(lmStudioStatus)
                : provider === 'gemini'
                  ? formatGeminiBadge()
                  : provider === 'firstParty'
                    ? formatBadge(getFirstPartyAuthState())
                    : formatBadge(getAuthState(provider))
            return (
              <Box key={provider}>
                <Text
                  bold={isSelected}
                  color={isSelected ? 'claude' : undefined}
                  dimColor={!isSelected}
                >
                  {prefix} {name.padEnd(16)}
                </Text>
                <Text> {badge}</Text>
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Enter to configure · Esc to close
          </Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'configure') {
    const provider = view.provider
    const name = getManageableProviderName(provider)
    const options = buildConfigureOptions(provider, ollamaStatus, lmStudioStatus)
    const badge =
      provider === VOICE_CONVERSATION_PROVIDER
        ? formatVoiceConversationBadge()
        : provider === E2B_SECURITY_PROVIDER
        ? chalk.green(formatE2BSecurityBadge())
        : provider === 'ollama'
        ? formatOllamaBadge(ollamaStatus)
        : provider === 'lmstudio'
        ? formatLmStudioBadge(lmStudioStatus)
        : provider === 'gemini'
          ? formatGeminiBadge()
          : provider === 'firstParty'
            ? formatBadge(getFirstPartyAuthState())
            : formatBadge(getAuthState(provider))
    const currentUrl =
      provider === 'ollama'
        ? getOllamaBaseUrl()
        : provider === 'lmstudio'
          ? getLmStudioBaseUrl()
          : null
    const voiceStatus =
      provider === VOICE_CONVERSATION_PROVIDER
        ? getVoiceConversationStatus()
        : null
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Box>
          <Text bold>{name}</Text>
          <Text> {badge}</Text>
        </Box>
        {currentUrl && (
          <Text dimColor>Base URL: {currentUrl}</Text>
        )}
        {voiceStatus && (
          <>
            <Text dimColor>Model: {voiceStatus.modelName}</Text>
            <Text dimColor>Voice: {voiceStatus.voiceName}</Text>
            <Text dimColor>
              Key: {voiceStatus.keySource ?? 'not saved'}
            </Text>
          </>
        )}
        <Box marginTop={1} flexDirection="column">
          {options.map((option, i) => {
            const isSelected = i === view.selectedIndex
            const prefix = isSelected ? '>' : ' '
            const label = labelConfigureOption(option, provider)
            return (
              <Text
                key={option.kind}
                bold={isSelected}
                color={isSelected ? 'claude' : undefined}
                dimColor={!isSelected}
              >
                {prefix} {label}
              </Text>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑↓ navigate · Enter to select · Esc to go back
          </Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'ollama_url_input') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text bold>Set Ollama base URL</Text>
        <Text dimColor>
          Default: <Text color="suggestion">{OLLAMA_DEFAULT_BASE}</Text>
        </Text>
        <Text dimColor>
          Accepts full URLs (http://host:port) or host:port shorthand.
        </Text>
        {view.error && (
          <Box marginTop={1}>
            <Text color="error">{view.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>URL: </Text>
          <TextInput
            value={ollamaUrlInput}
            onChange={setOllamaUrlInput}
            onSubmit={handleOllamaUrlSubmit}
            placeholder="http://localhost:11434"
            focus={true}
            showCursor={true}
            columns={inputColumns}
            cursorOffset={ollamaUrlCursorOffset}
            onChangeCursorOffset={setOllamaUrlCursorOffset}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to submit · Esc to go back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'lmstudio_url_input') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text bold>Set LM Studio base URL</Text>
        <Text dimColor>
          Default: <Text color="suggestion">{LMSTUDIO_DEFAULT_BASE}</Text>
        </Text>
        <Text dimColor>
          Accepts full URLs (http://host:port/v1) or host:port shorthand.
        </Text>
        {view.error && (
          <Box marginTop={1}>
            <Text color="error">{view.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>URL: </Text>
          <TextInput
            value={lmStudioUrlInput}
            onChange={setLmStudioUrlInput}
            onSubmit={handleLmStudioUrlSubmit}
            placeholder="http://localhost:1234/v1"
            focus={true}
            showCursor={true}
            columns={inputColumns}
            cursorOffset={lmStudioUrlCursorOffset}
            onChangeCursorOffset={setLmStudioUrlCursorOffset}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to submit Â· Esc to go back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'voice_key_input') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text bold>Set Gemini voice API key</Text>
        <Text dimColor>
          Get your API key at:{' '}
          <Text color="suggestion">https://aistudio.google.com/apikey</Text>
        </Text>
        <Text dimColor>
          Saved as {GEMINI_VOICE_KEY} and used immediately by /hey.
        </Text>
        {view.error && (
          <Box marginTop={1}>
            <Text color="error">{view.error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text>API Key: </Text>
          <TextInput
            value={voiceKeyInput}
            onChange={setVoiceKeyInput}
            onSubmit={handleVoiceKeySubmit}
            mask="*"
            placeholder="Paste your Gemini API key here..."
            focus={true}
            showCursor={true}
            columns={inputColumns}
            cursorOffset={voiceKeyCursorOffset}
            onChangeCursorOffset={setVoiceKeyCursorOffset}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to submit · Esc to go back</Text>
        </Box>
      </Box>
    )
  }

  if (view.kind === 'anthropic_login') {
    return <AnthropicLogin onDone={handleAnthropicLoginDone} />
  }

  if (view.kind === 'e2b_login') {
    return <E2BSecurityLogin onDone={handleE2BLoginDone} />
  }

  if (view.kind === 'provider_login') {
    const provider = view.provider
    return (
      <ProviderLoginFlow
        provider={provider}
        onDone={(success) => {
          refresh()
          setView({
            kind: 'result',
            provider,
            tone: success ? 'success' : 'error',
            message: success
              ? `${getManageableProviderName(provider)} credentials saved.`
              : `${getManageableProviderName(provider)} login cancelled.`,
          })
        }}
      />
    )
  }

  if (view.kind === 'result') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        {header}
        <Text color={view.tone === 'success' ? 'success' : 'error'}>
          {view.tone === 'success' ? '✓ ' : '✗ '}
          {view.message}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Enter to return to the provider list</Text>
        </Box>
      </Box>
    )
  }

  return null
}

// ─── Entry point ────────────────────────────────────────────────

export const call: LocalJSXCommandCall = async (onDone, context) => (
  <ProviderManager onDone={onDone} setMessages={context.setMessages} />
)
