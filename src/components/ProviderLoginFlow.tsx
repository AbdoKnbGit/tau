/**
 * ProviderLoginFlow — handles provider-specific login for third-party providers.
 *
 * For OAuth/browser-login providers: launches the provider sign-in flow.
 * For API-key providers: prompts for key input.
 */

import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import type { APIProvider } from '../utils/model/providers.js'
import { PROVIDER_DISPLAY_NAMES } from '../utils/model/providers.js'
import {
  deleteProviderKey,
  saveProviderKey,
  validateKeyFormat,
} from '../services/api/auth/api_key_manager.js'
import { startProviderOAuth, startGeminiOAuthFlow } from '../services/api/auth/provider_auth.js'
import {
  initiateCopilotOAuth, completeCopilotOAuth, type CopilotDeviceHandles,
  initiateClineOAuth, completeClineOAuth, type ClineDeviceHandles,
  initiateKiroOAuth, completeKiroOAuth, type KiroDeviceHandles,
  initiateKiroSocialOAuth, completeKiroSocialOAuth,
} from '../services/api/auth/oauth_services.js'
import { openBrowser } from '../utils/browser.js'
import TextInput from './TextInput.js'

// ─── Provider metadata ───────────────────────────────────────────

interface ProviderMeta {
  envVar: string
  keyPrefix?: string
  getKeyUrl: string
  supportsOAuth: boolean
  oauthOnly?: boolean
}

const PROVIDER_META: Partial<Record<APIProvider, ProviderMeta>> = {
  openai: {
    envVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.openai.com/api-keys',
    supportsOAuth: true,
  },
  gemini: {
    envVar: 'GEMINI_API_KEY',
    keyPrefix: 'AIza',
    getKeyUrl: 'https://aistudio.google.com/apikey',
    supportsOAuth: true,
  },
  antigravity: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://antigravity.google/',
    supportsOAuth: true,
    oauthOnly: true,
  },
  openrouter: {
    envVar: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    getKeyUrl: 'https://openrouter.ai/keys',
    supportsOAuth: false,
  },
  agentrouter: {
    envVar: 'AGENT_ROUTER_TOKEN',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://agentrouter.org/',
    supportsOAuth: false,
  },
  modelrouter: {
    envVar: 'MODEL_ROUTER_API_KEY',
    getKeyUrl: 'https://api.lxg2it.com/docs/api',
    supportsOAuth: false,
  },
  vercel: {
    envVar: 'AI_GATEWAY_API_KEY',
    getKeyUrl: 'https://vercel.com/docs/ai-gateway',
    supportsOAuth: false,
  },
  requesty: {
    envVar: 'REQUESTY_API_KEY',
    getKeyUrl: 'https://app.requesty.ai/api-keys',
    supportsOAuth: false,
  },
  opencode: {
    envVar: 'OPENCODE_API_KEY',
    getKeyUrl: 'https://opencode.ai/auth',
    supportsOAuth: false,
  },
  opencodego: {
    // Go shares the same OpenCode credential as Zen — one key powers both.
    envVar: 'OPENCODE_API_KEY',
    getKeyUrl: 'https://opencode.ai/auth',
    supportsOAuth: false,
  },
  commandcode: {
    envVar: 'CMD_API_KEY',
    getKeyUrl: 'https://commandcode.ai/studio/api-keys',
    supportsOAuth: false,
  },
  fireworks: {
    envVar: 'FIREWORKS_API_KEY',
    keyPrefix: 'fw_',
    getKeyUrl: 'https://fireworks.ai/account/api-keys',
    supportsOAuth: false,
  },
  cloudflare: {
    envVar: 'CLOUDFLARE_API_TOKEN',
    getKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    supportsOAuth: false,
  },
  mistral: {
    envVar: 'MISTRAL_API_KEY',
    getKeyUrl: 'https://console.mistral.ai/api-keys',
    supportsOAuth: false,
  },
  nim: {
    envVar: 'NIM_API_KEY',
    keyPrefix: 'nvapi-',
    getKeyUrl: 'https://build.nvidia.com/settings/api-keys',
    supportsOAuth: false,
  },
  deepseek: {
    envVar: 'DEEPSEEK_API_KEY',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.deepseek.com/api_keys',
    supportsOAuth: false,
  },
  glm: {
    envVar: 'GLM_API_KEY',
    getKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    supportsOAuth: false,
  },
  moonshot: {
    envVar: 'MOONSHOT_API_KEY',
    keyPrefix: 'sk-',
    getKeyUrl: 'https://platform.kimi.ai/console/api-keys',
    supportsOAuth: false,
  },
  minimax: {
    envVar: 'MINIMAX_API_KEY',
    getKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    supportsOAuth: false,
  },
  ollama: {
    envVar: 'OLLAMA_API_KEY',
    getKeyUrl: 'https://ollama.com/settings/keys',
    supportsOAuth: false,
  },
  kilocode: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://kilo.ai',
    supportsOAuth: true,
    oauthOnly: true,
  },
  cline: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://cline.bot',
    supportsOAuth: true,
    oauthOnly: true,
  },
  iflow: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://iflow.cn',
    supportsOAuth: true,
    oauthOnly: true,
  },
  copilot: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://github.com/features/copilot',
    supportsOAuth: true,
    oauthOnly: true,
  },
  kiro: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://kiro.dev',
    supportsOAuth: true,
    oauthOnly: true,
  },
  cursor: {
    envVar: '',
    keyPrefix: '',
    getKeyUrl: 'https://cursor.com',
    supportsOAuth: true,
    oauthOnly: true,
  },
}

type AuthMethod =
  | 'api_key'
  | 'oauth'
  | 'oauth_cli'
  | 'oauth_antigravity'
  | 'oauth_kiro_builder'
  | 'oauth_kiro_google'
  | 'oauth_kiro_github'

/** Quick API-level check that an API key actually works before saving it. */
async function _testApiKey(
  provider: APIProvider,
  key: string,
  options: { cloudflareAccountId?: string } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let url: string
    let headers: Record<string, string> = {}

    switch (provider) {
      case 'gemini':
        url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        break
      case 'openai':
        url = 'https://api.openai.com/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'mistral':
        url = 'https://api.mistral.ai/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'deepseek':
        url = 'https://api.deepseek.com/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'glm':
        url = 'https://open.bigmodel.cn/api/paas/v4/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'moonshot':
        url = 'https://api.moonshot.ai/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'minimax':
        url = 'https://api.minimax.io/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'openrouter':
        url = 'https://openrouter.ai/api/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'agentrouter':
        url = 'https://agentrouter.org/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'modelrouter':
        url = 'https://api.lxg2it.com/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'vercel':
        url = 'https://ai-gateway.vercel.sh/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'requesty':
        url = 'https://router.requesty.ai/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'opencode':
        url = 'https://opencode.ai/zen/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'opencodego':
        url = 'https://opencode.ai/zen/go/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'fireworks':
        url = 'https://api.fireworks.ai/inference/v1/models'
        headers = { Authorization: `Bearer ${key}` }
        break
      case 'cloudflare': {
        const accountId = options.cloudflareAccountId?.trim()
        if (!accountId) {
          return { ok: false, error: 'Cloudflare account ID is required.' }
        }
        url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/models`
        headers = { Authorization: `Bearer ${key}` }
        break
      }
      case 'commandcode':
        url = 'https://api.commandcode.ai/alpha/whoami'
        headers = {
          Authorization: `Bearer ${key}`,
          'x-cli-environment': 'production',
          'x-command-code-version': '0.32.2',
        }
        break
      default:
        // Can't test — accept optimistically
        return { ok: true }
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    })

    if (res.ok) return { ok: true }

    if (provider === 'cloudflare' && [400, 401, 403, 404].includes(res.status)) {
      return {
        ok: false,
        error: `Cloudflare validation failed (${res.status}). Check that the account ID is correct and the token has Workers AI access.`,
      }
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `API key rejected (${res.status}). Check that the key is correct and the API is enabled on your account.`,
      }
    }

    // Other errors (429, 500, etc.) — key format is OK, accept it
    return { ok: true }
  } catch {
    // Network error — can't test, accept optimistically
    return { ok: true }
  }
}

function reloadSavedApiKeyInRuntime(provider: APIProvider): void {
  if (provider === 'openai') {
    void import('../services/api/providers/providerShim.js')
      .then(({ reloadOpenAILaneAuth }) => reloadOpenAILaneAuth())
      .catch(() => {})
    return
  }

  if (provider === 'gemini') {
    void import('../services/api/providers/providerShim.js')
      .then(({ reloadGeminiLaneAuth }) => reloadGeminiLaneAuth())
      .catch(() => {})
    return
  }

  if (
    provider === 'deepseek' ||
    provider === 'glm' ||
    provider === 'mistral' ||
    provider === 'moonshot' ||
    provider === 'nim' ||
    provider === 'openrouter' ||
    provider === 'agentrouter' ||
    provider === 'modelrouter' ||
    provider === 'vercel' ||
    provider === 'requesty' ||
    provider === 'opencode' ||
    provider === 'opencodego' ||
    provider === 'commandcode' ||
    provider === 'fireworks' ||
    provider === 'cloudflare' ||
    provider === 'minimax' ||
    provider === 'ollama'
  ) {
    void import('../services/api/providers/providerShim.js')
      .then(({ reloadOpenAICompatProviderAuth }) =>
        reloadOpenAICompatProviderAuth(provider),
      )
      .catch(() => {})
  }
}

async function reloadSavedGoogleOAuthInRuntime(
  provider: APIProvider,
  method: AuthMethod,
): Promise<void> {
  const isGoogleOAuth =
    (provider === 'gemini' && method === 'oauth_cli') ||
    (provider === 'antigravity' && method === 'oauth_antigravity')
  if (!isGoogleOAuth) return

  const executor = method === 'oauth_antigravity' || provider === 'antigravity'
    ? 'antigravity'
    : 'cli'

  try {
    const [{ clearCodeAssistCache }, { reloadGeminiLaneAuth }] = await Promise.all([
      import('../services/api/providers/gemini_code_assist.js'),
      import('../services/api/providers/providerShim.js'),
    ])
    clearCodeAssistCache(executor)
    await reloadGeminiLaneAuth()
  } catch {
    // Tokens are saved; the next provider init will still read them from disk.
  }
}

type Props = {
  provider: APIProvider
  onDone: (success: boolean) => void
}

type FlowState =
  | { step: 'choose_method' }
  | { step: 'api_key_input'; error?: string }
  | { step: 'cloudflare_account_id_input'; error?: string }
  | { step: 'cloudflare_api_token_input'; accountId: string; error?: string }
  | { step: 'oauth_pending' }
  | { step: 'device_code'; userCode: string; verificationUri: string }
  | { step: 'kiro_social_callback'; providerLabel: string; authUrl: string }
  | { step: 'validating' }
  | { step: 'success' }
  | { step: 'error'; message: string }

export function ProviderLoginFlow({ provider, onDone }: Props) {
  const meta = PROVIDER_META[provider]
  const name = PROVIDER_DISPLAY_NAMES[provider]
  const supportsOAuth = meta?.supportsOAuth ?? false
  const oauthOnly = meta?.oauthOnly ?? false

  // Gemini now = free-tier Google OAuth or Studio API key. Antigravity
  // has its own provider row and runs the antigravity-tier flow itself.
  const isGemini = provider === 'gemini'
  const isAntigravity = provider === 'antigravity'
  const isKiro = provider === 'kiro'
  const isCursor = provider === 'cursor'
  const methodOptions: { method: AuthMethod; label: string }[] = isGemini
    ? [
        { method: 'oauth_cli', label: 'Google OAuth (free tier — flash/lite)' },
        { method: 'api_key', label: 'API Key (AI Studio)' },
      ]
    : isAntigravity
      ? [
          { method: 'oauth_antigravity', label: 'Antigravity login (Gemini 3 Flash / 3.1 Pro high/low)' },
        ]
      : isKiro
        ? [
            { method: 'oauth_kiro_builder', label: 'AWS Builder ID' },
          ]
      : oauthOnly
        ? [{ method: 'oauth', label: isCursor ? 'Cursor browser login' : 'OAuth (Browser Login)' }]
        : supportsOAuth
          ? [
              { method: 'oauth', label: 'OAuth (Browser Login)' },
              { method: 'api_key', label: 'API Key' },
            ]
          : []

  const [state, setState] = useState<FlowState>(
    provider === 'cloudflare'
      ? { step: 'cloudflare_account_id_input' }
      : methodOptions.length > 0
        ? { step: 'choose_method' }
        : { step: 'api_key_input' },
  )
  const [cloudflareAccountInput, setCloudflareAccountInput] = useState('')
  const [cloudflareAccountCursorOffset, setCloudflareAccountCursorOffset] = useState(0)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyCursorOffset, setApiKeyCursorOffset] = useState(0)
  const [callbackUrlInput, setCallbackUrlInput] = useState('')
  const [callbackUrlCursorOffset, setCallbackUrlCursorOffset] = useState(0)
  const [kiroSocialState, setKiroSocialState] = useState<{
    providerLabel: string
    provider: 'google' | 'github'
    expectedState: string
    codeVerifier: string
  } | null>(null)
  const [selectedMethod, setSelectedMethod] = useState<number>(0)
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 12)

  function runOAuthFlow(method: AuthMethod) {
    // Cline, GitHub Copilot, and Kiro use device-code flows that need the user_code
    // visible in the terminal (the verification_uri does NOT pre-fill
    // the code for Copilot, and Kiro's completeUri isn't always honored).
    if (provider === 'copilot') {
      setState({ step: 'oauth_pending' })
      initiateCopilotOAuth()
        .then(async (handles: CopilotDeviceHandles) => {
          setState({
            step: 'device_code',
            userCode: handles.userCode,
            verificationUri: handles.verificationUri,
          })
          void openBrowser(handles.verificationUri).catch(() => {})
          const tokens = await completeCopilotOAuth(handles)
          deleteProviderKey(provider)
          setState({ step: 'success' })
          setTimeout(() => onDone(true), 1000)
          return tokens
        })
        .catch((err) => {
          setState({ step: 'error', message: err?.message ?? 'Copilot OAuth failed' })
        })
      return
    }

    if (provider === 'cline') {
      setState({ step: 'oauth_pending' })
      initiateClineOAuth()
        .then(async (handles: ClineDeviceHandles) => {
          const verificationUri = handles.verificationUriComplete || handles.verificationUri
          setState({
            step: 'device_code',
            userCode: handles.userCode,
            verificationUri,
          })
          void openBrowser(verificationUri).catch(() => {})
          const tokens = await completeClineOAuth(handles)
          deleteProviderKey(provider)
          void import('../services/api/providers/providerShim.js')
            .then(({ reloadClineLaneAuth }) => reloadClineLaneAuth())
            .catch(() => {})
          setState({ step: 'success' })
          setTimeout(() => onDone(true), 1000)
          return tokens
        })
        .catch((err) => {
          setState({ step: 'error', message: err?.message ?? 'Cline OAuth failed' })
        })
      return
    }

    if (provider === 'kiro') {
      if (method === 'oauth_kiro_google' || method === 'oauth_kiro_github') {
        const socialProvider = method === 'oauth_kiro_google' ? 'google' : 'github'
        const providerLabel = socialProvider === 'google' ? 'Google' : 'GitHub'
        setState({ step: 'oauth_pending' })
        initiateKiroSocialOAuth(socialProvider)
          .then(async (handles) => {
            setKiroSocialState({
              provider: socialProvider,
              providerLabel,
              expectedState: handles.state,
              codeVerifier: handles.codeVerifier,
            })
            setCallbackUrlInput('')
            setCallbackUrlCursorOffset(0)
            setState({
              step: 'kiro_social_callback',
              providerLabel,
              authUrl: handles.authUrl,
            })
            void openBrowser(handles.authUrl).catch(() => {})
          })
          .catch((err) => {
            setState({ step: 'error', message: err?.message ?? 'Kiro social OAuth failed' })
          })
        return
      }

      setState({ step: 'oauth_pending' })
      initiateKiroOAuth()
        .then(async (handles: KiroDeviceHandles) => {
          setState({
            step: 'device_code',
            userCode: handles.userCode,
            verificationUri: handles.verificationUriComplete || handles.verificationUri,
          })
          void openBrowser(handles.verificationUriComplete || handles.verificationUri).catch(() => {})
          const tokens = await completeKiroOAuth(handles)
          deleteProviderKey(provider)
          setState({ step: 'success' })
          setTimeout(() => onDone(true), 1000)
          return tokens
        })
        .catch((err) => {
          setState({ step: 'error', message: err?.message ?? 'Kiro OAuth failed' })
        })
      return
    }

    setState({ step: 'oauth_pending' })
    const oauthPromise =
      method === 'oauth_cli' ? startGeminiOAuthFlow('cli')
        : method === 'oauth_antigravity' ? startGeminiOAuthFlow('antigravity')
          : startProviderOAuth(provider)
    oauthPromise
      .then(async () => {
        // Activating OAuth deactivates API key for this provider.
        deleteProviderKey(provider)
        if (provider === 'openai') {
          await import('../services/api/providers/providerShim.js')
            .then(({ reloadOpenAILaneAuth }) => reloadOpenAILaneAuth())
            .catch(() => {})
        }
        await reloadSavedGoogleOAuthInRuntime(provider, method)
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 1000)
      })
      .catch((err) => {
        setState({ step: 'error', message: err?.message ?? 'OAuth flow failed' })
      })
  }

  function handleKiroSocialCallbackSubmit(value: string) {
    const callbackUrl = value.trim()
    if (!callbackUrl || !kiroSocialState) return

    setState({ step: 'validating' })
    completeKiroSocialOAuth({
      provider: kiroSocialState.provider,
      callbackUrl,
      codeVerifier: kiroSocialState.codeVerifier,
      expectedState: kiroSocialState.expectedState,
    })
      .then(() => {
        deleteProviderKey('kiro')
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 1000)
      })
      .catch((err) => {
        setState({
          step: 'error',
          message: (err as Error)?.message ?? 'Kiro social OAuth failed',
        })
      })
  }

  useInput((input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (key.escape) {
      onDone(false)
      return
    }

    if (state.step === 'choose_method') {
      const total = methodOptions.length
      if (key.upArrow) {
        setSelectedMethod((i) => (i > 0 ? i - 1 : total - 1))
        return
      }
      if (key.downArrow) {
        setSelectedMethod((i) => (i < total - 1 ? i + 1 : 0))
        return
      }
      if (key.return) {
        const chosen = methodOptions[selectedMethod]
        if (!chosen) return
        if (chosen.method === 'api_key') {
          setState({ step: 'api_key_input' })
        } else {
          runOAuthFlow(chosen.method)
        }
      }
    }

    if (state.step === 'success') {
      onDone(true)
    }
    if (state.step === 'error' && key.return) {
      onDone(false)
    }
  })

  // ─── API key submission handler ──────────────────────────────────
  //
  // Save is unconditional — for every provider, every key shape, every
  // model tier. Format checks (prefix rules) and the /models network
  // test are both advisory: they never block the save. Rationale:
  //   - Provider prefix rules drift (NVIDIA ships non-nvapi- keys for
  //     certain models; DeepSeek Coder tokens vary; proxies re-issue
  //     keys with their own schemes).
  //   - /models 401/403 can fail on a perfectly valid key when the key
  //     is plan-tier-restricted or scoped to a subset of endpoints.
  //   - A saved-but-flagged key is strictly better UX than a rejected
  //     key; the user sees the warning and either keeps it or retries.
  function handleApiKeySubmit(value: string) {
    const key = value.trim()
    if (!key) return

    setState({ step: 'validating' })

    const persistAndFinish = (warnings: string[]) => {
      saveProviderKey(provider, key)
      deleteProviderKey(`${provider}_oauth`)
      if (provider === 'gemini') {
        // Only clear the CLI-tier Gemini OAuth. The Antigravity OAuth is
        // owned by its own provider row now — don't nuke it from under
        // the user just because they added a Studio key.
        deleteProviderKey('gemini_oauth_cli')
      }
      const envVar = meta?.envVar
      if (envVar) process.env[envVar] = key
      if (provider === 'agentrouter') process.env.AGENTROUTER_API_KEY = key
      if (provider === 'modelrouter') process.env.MODELROUTER_API_KEY = key
      if (provider === 'vercel') process.env.VERCEL_AI_GATEWAY_API_KEY = key
      if (provider === 'opencode') process.env.OPENCODE_ZEN_API_KEY = key
      if (provider === 'opencodego') {
        // Go and Zen share one OpenCode credential. Mirror the key into the
        // shared OpenCode env + stored slot so logging into either tier
        // authenticates both.
        process.env.OPENCODE_API_KEY = key
        process.env.OPENCODE_ZEN_API_KEY = key
        saveProviderKey('opencode', key)
      }
      if (provider === 'commandcode') {
        process.env.COMMANDCODE_API_KEY = key
        process.env.COMMAND_CODE_API_KEY = key
      }
      reloadSavedApiKeyInRuntime(provider)
      if (warnings.length > 0) {
        setState({
          step: 'error',
          message: `Key saved. Warnings:\n  • ${warnings.join('\n  • ')}`,
        })
        setTimeout(() => onDone(true), 2000)
      } else {
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 800)
      }
    }

    const warnings: string[] = []
    const formatCheck = validateKeyFormat(provider, key)
    if (!formatCheck.valid && formatCheck.error) warnings.push(formatCheck.error)

    _testApiKey(provider, key)
      .then((testResult) => {
        if (!testResult.ok) warnings.push(testResult.error)
        persistAndFinish(warnings)
      })
      .catch(() => persistAndFinish(warnings))
  }

  function handleCloudflareAccountSubmit(value: string) {
    const accountId = value.trim()
    if (!accountId) {
      setState({
        step: 'cloudflare_account_id_input',
        error: 'Cloudflare account ID cannot be empty.',
      })
      return
    }
    if (/\s/.test(accountId) || accountId.includes('/')) {
      setState({
        step: 'cloudflare_account_id_input',
        error: 'Cloudflare account ID should not contain spaces or slashes.',
      })
      return
    }
    setState({ step: 'cloudflare_api_token_input', accountId })
  }

  function handleCloudflareTokenSubmit(value: string) {
    const key = value.trim()
    if (!key || state.step !== 'cloudflare_api_token_input') return

    const accountId = state.accountId
    setState({ step: 'validating' })

    const persistAndFinish = (warnings: string[]) => {
      saveProviderKey('cloudflare_account_id', accountId)
      saveProviderKey('cloudflare', key)
      deleteProviderKey('cloudflare_oauth')

      process.env.CLOUDFLARE_ACCOUNT_ID = accountId
      process.env.CLOUDFLARE_API_TOKEN = key
      process.env.CLOUDFLARE_API_KEY = key
      process.env.CLOUDFLARE_WORKERS_AI_TOKEN = key

      reloadSavedApiKeyInRuntime('cloudflare')
      if (warnings.length > 0) {
        setState({
          step: 'error',
          message: `Cloudflare credentials saved. Warnings:\n  - ${warnings.join('\n  - ')}`,
        })
        setTimeout(() => onDone(true), 2000)
      } else {
        setState({ step: 'success' })
        setTimeout(() => onDone(true), 800)
      }
    }

    const warnings: string[] = []
    const formatCheck = validateKeyFormat('cloudflare', key)
    if (!formatCheck.valid && formatCheck.error) warnings.push(formatCheck.error)

    _testApiKey(provider, key, { cloudflareAccountId: accountId })
      .then((testResult) => {
        if (!testResult.ok) {
          setState({
            step: 'cloudflare_api_token_input',
            accountId,
            error: testResult.error,
          })
          return
        }
        persistAndFinish(warnings)
      })
      .catch(() => persistAndFinish(warnings))
  }

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box marginBottom={1}>
        <Text bold color="claude">
          Login to {name}
        </Text>
      </Box>

      {state.step === 'choose_method' && (
        <Box flexDirection="column">
          <Text dimColor>Choose authentication method:</Text>
          <Box marginTop={1} flexDirection="column">
            {methodOptions.map((opt, i) => (
              <Text key={opt.method} bold={selectedMethod === i} color={selectedMethod === i ? 'claude' : undefined}>
                {selectedMethod === i ? '> ' : '  '}{opt.label}
              </Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Arrow keys to select, Enter to confirm, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'api_key_input' && (
        <Box flexDirection="column">
          {meta && (
            <Text dimColor>
              Get your API key at: <Text color="suggestion">{meta.getKeyUrl}</Text>
            </Text>
          )}
          {meta && (provider !== 'ollama' || meta.keyPrefix) && (
            <Text dimColor>
              Expected format: <Text color="warning">{meta.keyPrefix ?? ''}...</Text>
            </Text>
          )}
          {'error' in state && state.error && (
            <Box marginTop={1}>
              <Text color="error">{state.error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>API Key: </Text>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleApiKeySubmit}
              mask="*"
              placeholder="Paste your API key here..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={apiKeyCursorOffset}
              onChangeCursorOffset={setApiKeyCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to submit, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'cloudflare_account_id_input' && (
        <Box flexDirection="column">
          <Text dimColor>
            Get your account ID from Cloudflare Account Home or the dashboard URL.
          </Text>
          {state.error && (
            <Box marginTop={1}>
              <Text color="error">{state.error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>Account ID: </Text>
            <TextInput
              value={cloudflareAccountInput}
              onChange={setCloudflareAccountInput}
              onSubmit={handleCloudflareAccountSubmit}
              placeholder="Paste your Cloudflare account ID..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={cloudflareAccountCursorOffset}
              onChangeCursorOffset={setCloudflareAccountCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to continue, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'cloudflare_api_token_input' && (
        <Box flexDirection="column">
          <Text dimColor>
            Create an API token with Workers AI access at: <Text color="suggestion">https://dash.cloudflare.com/profile/api-tokens</Text>
          </Text>
          {state.error && (
            <Box marginTop={1}>
              <Text color="error">{state.error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>API Token: </Text>
            <TextInput
              value={apiKeyInput}
              onChange={setApiKeyInput}
              onSubmit={handleCloudflareTokenSubmit}
              mask="*"
              placeholder="Paste your Cloudflare API token..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={apiKeyCursorOffset}
              onChangeCursorOffset={setApiKeyCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to validate, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'oauth_pending' && (
        <Box flexDirection="column">
          <Text color="warning">Opening browser for {name} authentication...</Text>
          <Text dimColor>
            {provider === 'cursor'
              ? 'Complete the login in your browser. Waiting for Cursor to confirm the sign-in...'
              : provider === 'cline' || provider === 'copilot' || provider === 'kiro'
                ? 'Waiting for the device code...'
              : 'Complete the login in your browser. Waiting for callback...'}
          </Text>
        </Box>
      )}

      {state.step === 'device_code' && (
        <Box flexDirection="column">
          <Text color="warning">Enter this code in your browser to authorize {name}:</Text>
          <Box marginTop={1} marginBottom={1}>
            <Text bold color="claude">  {state.userCode}</Text>
          </Box>
          <Text dimColor>URL: <Text color="suggestion">{state.verificationUri}</Text></Text>
          <Text dimColor>Waiting for authorization...</Text>
        </Box>
      )}

      {state.step === 'kiro_social_callback' && (
        <Box flexDirection="column">
          <Text bold>Step 1 — Sign in with {state.providerLabel} in your browser</Text>
          <Text dimColor>If it didn't open, copy this URL:</Text>
          <Box marginLeft={2} marginBottom={1}>
            <Text color="suggestion">{state.authUrl}</Text>
          </Box>
          <Text bold>Step 2 — Paste the callback URL below</Text>
          <Text dimColor>
            After sign-in the browser will show a protocol warning (Chrome: "External Protocol"; Firefox: "don't know how to open") or appear to hang. That's expected — Kiro redirects to <Text color="suggestion">kiro://</Text>, which no browser handles locally.
          </Text>
          <Text dimColor>
            Copy the full URL from the address bar (it contains <Text color="suggestion">?code=...&state=...</Text>) and paste it here. The bare query string works too.
          </Text>
          <Box marginTop={1}>
            <Text>Callback URL: </Text>
            <TextInput
              value={callbackUrlInput}
              onChange={setCallbackUrlInput}
              onSubmit={handleKiroSocialCallbackSubmit}
              placeholder="kiro://kiro.kiroAgent/authenticate-success?code=..."
              focus={true}
              showCursor={true}
              columns={inputColumns}
              cursorOffset={callbackUrlCursorOffset}
              onChangeCursorOffset={setCallbackUrlCursorOffset}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter to submit, Esc to cancel</Text>
          </Box>
        </Box>
      )}

      {state.step === 'validating' && (
        <Text color="warning">Validating credentials...</Text>
      )}

      {state.step === 'success' && (
        <Text color="success">Successfully logged in to {name}!</Text>
      )}

      {state.step === 'error' && (
        <Box flexDirection="column">
          <Text color="error">Login failed: {state.message}</Text>
          <Text dimColor>Press Enter to dismiss, or try again with /login</Text>
        </Box>
      )}
    </Box>
  )
}
