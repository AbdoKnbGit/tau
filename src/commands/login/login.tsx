import { feature } from 'bun:bundle'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { ProviderLoginFlow } from '../../components/ProviderLoginFlow.js'
import TextInput from '../../components/TextInput.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text, useInput } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  getProviderAuthMethod,
  PROVIDER_AUTH_SUPPORT,
} from '../../utils/auth.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  getAPIProvider,
  PROVIDER_DISPLAY_NAMES,
  SELECTABLE_PROVIDERS,
  setActiveProvider,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'
import {
  hasStoredKey,
  saveProviderKey,
  validateKeyFormat,
} from '../../services/api/auth/api_key_manager.js'
import {
  activateGeminiVoiceConversation,
  hasStoredVoiceConversationKey,
  saveVoiceConversationApiKey,
} from '../../voice/voiceConversation.js'
import {
  FIRECRAWL_API_KEY_ENV,
  FIRECRAWL_DISPLAY_NAME,
  FIRECRAWL_PROVIDER_KEY,
  testFirecrawlApiKey,
} from '../../tools/WebSearchTool/firecrawl.js'
import {
  E2B_DASHBOARD_URL,
  E2B_SECURITY_DISPLAY_NAME,
  E2B_SECURITY_PROVIDER,
  hasE2BSecurityAuth,
  openE2BDashboardInBrowser,
  saveE2BSecurityCredential,
} from '../../utils/safetest/e2bSecurity.js'

// ─── Post-login refresh (shared between Anthropic and 3P flows) ──

function runPostLoginRefresh(context: LocalJSXCommandContext) {
  resetCostState()
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()
  clearTrustedDeviceToken()
  void enrollTrustedDevice()
  resetBypassPermissionsCheck()
  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }
  context.setAppState((prev) => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
}

// ─── Main login entry point ──────────────────────────────────────
//
// /login is the general provider login entry point. Selecting Anthropic from
// here opens the native Claude OAuth flow (subscription / Console API /
// platform). /provider reuses the exported Login component for the same
// Anthropic-only screen.

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args = '',
): Promise<React.ReactNode> {
  const currentProvider = getAPIProvider()
  const finish = (success: boolean) => {
    if (success) {
      context.onChangeAPIKey()
      context.setMessages(stripSignatureBlocks)
      runPostLoginRefresh(context)
    }
    onDone(success ? 'Login successful' : 'Login interrupted')
  }

  if (matchesE2BSecurityArg(args)) {
    return <E2BSecurityLogin onDone={finish} />
  }
  if (matchesFirecrawlArg(args)) {
    return <FirecrawlLogin onDone={finish} />
  }

  return (
    <ProviderPickerLogin
      initialProvider={currentProvider}
      onDone={finish}
    />
  )
}

function matchesE2BSecurityArg(args: string): boolean {
  const first = args.trim().toLowerCase().split(/\s+/)[0]
  return first === E2B_SECURITY_PROVIDER || first === 'e2b'
}

function matchesFirecrawlArg(args: string): boolean {
  const first = args.trim().toLowerCase().split(/\s+/)[0]
  return first === FIRECRAWL_PROVIDER_KEY || first === 'websearch'
}

const GEMINI_VOICE_LOGIN_TARGET = 'geminiVoice' as const
const E2B_SECURITY_LOGIN_TARGET = E2B_SECURITY_PROVIDER
const FIRECRAWL_LOGIN_TARGET = FIRECRAWL_PROVIDER_KEY
type LoginTarget =
  | APIProvider
  | typeof GEMINI_VOICE_LOGIN_TARGET
  | typeof E2B_SECURITY_LOGIN_TARGET
  | typeof FIRECRAWL_LOGIN_TARGET

const LOGIN_PROVIDERS = [
  ...SELECTABLE_PROVIDERS,
  GEMINI_VOICE_LOGIN_TARGET,
  E2B_SECURITY_LOGIN_TARGET,
  FIRECRAWL_LOGIN_TARGET,
] as const satisfies readonly LoginTarget[]

function getLoginTargetName(target: LoginTarget): string {
  if (target === GEMINI_VOICE_LOGIN_TARGET) return 'Gemini Voice'
  if (target === E2B_SECURITY_LOGIN_TARGET) return E2B_SECURITY_DISPLAY_NAME
  if (target === FIRECRAWL_LOGIN_TARGET) return FIRECRAWL_DISPLAY_NAME
  return PROVIDER_DISPLAY_NAMES[target]
}

function getProviderAuthTypeLabel(provider: LoginTarget): string {
  if (provider === GEMINI_VOICE_LOGIN_TARGET) return 'Gemini API key'
  if (provider === E2B_SECURITY_LOGIN_TARGET) return 'E2B API key / auth token'
  if (provider === FIRECRAWL_LOGIN_TARGET) return 'Firecrawl API key'
  if (provider === 'firstParty') {
    return 'claude subscription / Console API / platform'
  }
  if (provider === 'antigravity') return 'Google login'
  if (provider === 'gemini') return 'Google / API key'
  if (provider === 'cursor') return 'Browser login'

  const supported = PROVIDER_AUTH_SUPPORT[provider] ?? ['api_key']
  const supportsOAuth = supported.includes('oauth')
  const supportsApiKey = supported.includes('api_key')

  if (supportsOAuth && supportsApiKey) return 'OAuth / API key'
  if (supportsOAuth) return 'OAuth'
  return 'API key'
}

function getProviderConfiguredLabel(provider: LoginTarget): string {
  if (provider === GEMINI_VOICE_LOGIN_TARGET) {
    return hasStoredVoiceConversationKey() ? ' [API key saved]' : ''
  }
  if (provider === E2B_SECURITY_LOGIN_TARGET) {
    return hasE2BSecurityAuth() ? ' [auth ready]' : ''
  }
  if (provider === FIRECRAWL_LOGIN_TARGET) {
    if (process.env[FIRECRAWL_API_KEY_ENV]?.trim()) return ' [env key ready]'
    return hasStoredKey(FIRECRAWL_PROVIDER_KEY) ? ' [API key saved]' : ''
  }
  const method = getProviderAuthMethod(provider)
  if (method === 'oauth') return ' [OAuth connected]'
  if (method === 'api_key') return ' [API key saved]'
  return ''
}

function ProviderPickerLogin({
  initialProvider,
  onDone,
}: {
  initialProvider: APIProvider
  onDone: (success: boolean) => void
}) {
  const [selectedProvider, setSelectedProvider] = useState<LoginTarget | null>(null)
  const initialIndex = Math.max(0, LOGIN_PROVIDERS.indexOf(initialProvider))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)

  useInput((_input: string, key: { return?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean }) => {
    if (selectedProvider) return

    if (key.escape) {
      onDone(false)
      return
    }
    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : LOGIN_PROVIDERS.length - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => (i < LOGIN_PROVIDERS.length - 1 ? i + 1 : 0))
      return
    }
    if (key.return) {
      const provider = LOGIN_PROVIDERS[selectedIndex]
      if (provider) setSelectedProvider(provider)
    }
  })

  if (selectedProvider) {
    const providerForLogin = selectedProvider
    const handleProviderDone = (success: boolean) => {
      if (success) {
        if (
          providerForLogin !== GEMINI_VOICE_LOGIN_TARGET &&
          providerForLogin !== E2B_SECURITY_LOGIN_TARGET &&
          providerForLogin !== FIRECRAWL_LOGIN_TARGET
        ) {
          setActiveProvider(providerForLogin)
        }
        onDone(true)
        return
      }
      setSelectedProvider(null)
    }

    if (providerForLogin === 'firstParty') {
      return <Login onDone={handleProviderDone} />
    }
    if (providerForLogin === GEMINI_VOICE_LOGIN_TARGET) {
      return <GeminiVoiceLogin onDone={handleProviderDone} />
    }
    if (providerForLogin === E2B_SECURITY_LOGIN_TARGET) {
      return <E2BSecurityLogin onDone={handleProviderDone} />
    }
    if (providerForLogin === FIRECRAWL_LOGIN_TARGET) {
      return <FirecrawlLogin onDone={handleProviderDone} />
    }
    return (
      <ThirdPartyLogin
        provider={providerForLogin}
        onDone={handleProviderDone}
      />
    )
  }

  return (
    <Dialog
      title="Login - Choose Provider"
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <Box flexDirection="column" paddingLeft={1}>
        <Box marginBottom={1}>
          <Text bold color="claude">
            Select a provider to sign in with:
          </Text>
        </Box>
        {LOGIN_PROVIDERS.map((provider, index) => {
          const isSelected = index === selectedIndex
          return (
            <Box key={provider}>
              <Text
                bold={isSelected}
                color={isSelected ? 'claude' : undefined}
                dimColor={!isSelected}
              >
                {isSelected ? '> ' : '  '}
                {getLoginTargetName(provider)}
              </Text>
              <Text dimColor>
                {' '}({getProviderAuthTypeLabel(provider)})
                {getProviderConfiguredLabel(provider)}
              </Text>
            </Box>
          )
        })}
        <Box marginTop={1}>
          <Text dimColor>Use arrow keys, Enter to select, Esc to cancel</Text>
        </Box>
      </Box>
    </Dialog>
  )
}

function GeminiVoiceLogin({
  onDone,
}: {
  onDone: (success: boolean) => void
}) {
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyCursorOffset, setApiKeyCursorOffset] = useState(0)
  const [state, setState] = useState<
    | { step: 'input'; error?: string }
    | { step: 'success'; message: string }
    | { step: 'warning'; message: string }
  >({ step: 'input' })
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 12)

  useEffect(() => {
    if (state.step === 'input') return
    const timer = setTimeout(() => onDone(true), state.step === 'warning' ? 1800 : 800)
    return () => clearTimeout(timer)
  }, [onDone, state.step])

  function handleSubmit(value: string) {
    const key = value.trim()
    if (!key) {
      setState({ step: 'input', error: 'API key cannot be empty.' })
      return
    }

    saveVoiceConversationApiKey(key)
    const result = activateGeminiVoiceConversation()
    if (result.error) {
      setState({
        step: 'input',
        error:
          'Key saved, but Tau could not update settings. Check your settings file for syntax errors.',
      })
      return
    }

    const formatCheck = validateKeyFormat('gemini', key)
    if (!formatCheck.valid && formatCheck.error) {
      setState({
        step: 'warning',
        message: `Gemini voice key saved. Warning: ${formatCheck.error}`,
      })
      return
    }

    setState({
      step: 'success',
      message: 'Gemini voice key saved. Voice conversation is active for /hey.',
    })
  }

  return (
    <Dialog
      title="Login - Gemini Voice"
      onCancel={() => onDone(false)}
      color="permission"
    >
      <Box flexDirection="column" paddingLeft={1}>
        {state.step === 'input' && (
          <>
            <Text dimColor>
              Get your API key at:{' '}
              <Text color="suggestion">https://aistudio.google.com/apikey</Text>
            </Text>
            <Text dimColor>
              Saved as gemini_voice and used immediately by /hey.
            </Text>
            {state.error && (
              <Box marginTop={1}>
                <Text color="error">{state.error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text>API Key: </Text>
              <TextInput
                value={apiKeyInput}
                onChange={setApiKeyInput}
                onSubmit={handleSubmit}
                mask="*"
                placeholder="Paste your Gemini API key here..."
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
          </>
        )}
        {state.step === 'success' && (
          <Text color="success">{state.message}</Text>
        )}
        {state.step === 'warning' && (
          <Text color="warning">{state.message}</Text>
        )}
      </Box>
    </Dialog>
  )
}

// ─── Auxiliary login dialogs ───

function FirecrawlLogin({
  onDone,
}: {
  onDone: (success: boolean) => void
}) {
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyCursorOffset, setApiKeyCursorOffset] = useState(0)
  const [state, setState] = useState<
    | { step: 'input'; error?: string }
    | { step: 'validating' }
    | { step: 'success'; message: string }
    | { step: 'warning'; message: string }
  >({ step: 'input' })
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 12)

  useEffect(() => {
    if (state.step !== 'success' && state.step !== 'warning') return
    const timer = setTimeout(
      () => onDone(true),
      state.step === 'warning' ? 2000 : 800,
    )
    return () => clearTimeout(timer)
  }, [onDone, state.step])

  function handleSubmit(value: string) {
    const key = value.trim()
    if (!key) {
      setState({ step: 'input', error: 'Firecrawl API key cannot be empty.' })
      return
    }

    setState({ step: 'validating' })
    const warnings: string[] = []
    const formatCheck = validateKeyFormat(FIRECRAWL_PROVIDER_KEY, key)
    if (!formatCheck.valid && formatCheck.error) {
      warnings.push(formatCheck.error)
    }

    const persistAndFinish = () => {
      saveProviderKey(FIRECRAWL_PROVIDER_KEY, key)
      process.env[FIRECRAWL_API_KEY_ENV] = key
      if (warnings.length > 0) {
        setState({
          step: 'warning',
          message: `Firecrawl key saved. Warning: ${warnings.join(' ')}`,
        })
        return
      }
      setState({
        step: 'success',
        message: 'Firecrawl key saved. WebSearch is available for all providers.',
      })
    }

    testFirecrawlApiKey(key)
      .then(testResult => {
        if (!testResult.ok) warnings.push(testResult.error)
        persistAndFinish()
      })
      .catch(() => persistAndFinish())
  }

  return (
    <Dialog
      title={`Login - ${FIRECRAWL_DISPLAY_NAME}`}
      onCancel={() => onDone(false)}
      color="permission"
    >
      <Box flexDirection="column" paddingLeft={1}>
        {state.step === 'input' && (
          <>
            <Text dimColor>
              Get your API key at:{' '}
              <Text color="suggestion">https://www.firecrawl.dev/app/api-keys</Text>
            </Text>
            <Text dimColor>
              Used by WebSearch when the active model provider has no native web search.
            </Text>
            {state.error && (
              <Box marginTop={1}>
                <Text color="error">{state.error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text>API Key: </Text>
              <TextInput
                value={apiKeyInput}
                onChange={setApiKeyInput}
                onSubmit={handleSubmit}
                mask="*"
                placeholder="Paste your Firecrawl API key here..."
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
          </>
        )}
        {state.step === 'validating' && (
          <Text color="warning">Validating Firecrawl credentials...</Text>
        )}
        {state.step === 'success' && (
          <Text color="success">{state.message}</Text>
        )}
        {state.step === 'warning' && (
          <Text color="warning">{state.message}</Text>
        )}
      </Box>
    </Dialog>
  )
}

type E2BSecurityLoginMethod = 'authLogin' | 'apiKey'

const E2B_SECURITY_LOGIN_METHODS: Array<{
  method: E2BSecurityLoginMethod
  label: string
  description: string
}> = [
  {
    method: 'authLogin',
    label: 'Auth login',
    description: 'open the E2B dashboard in your browser',
  },
  {
    method: 'apiKey',
    label: 'API key',
    description: 'paste an existing E2B API key',
  },
]

export function E2BSecurityLogin({
  onDone,
}: {
  onDone: (success: boolean) => void
}) {
  const [method, setMethod] = useState<E2BSecurityLoginMethod | null>(null)
  const [selectedMethodIndex, setSelectedMethodIndex] = useState(0)
  const [secretInput, setSecretInput] = useState('')
  const [secretCursorOffset, setSecretCursorOffset] = useState(0)
  const [browserStatus, setBrowserStatus] = useState<
    'opening' | 'opened' | 'fallback'
  >('opening')
  const [state, setState] = useState<
    | { step: 'input'; error?: string }
    | { step: 'success'; message: string }
  >({ step: 'input' })
  const inputColumns = Math.max(20, (process.stdout.columns ?? 80) - 14)

  useEffect(() => {
    if (method !== 'authLogin') return
    let cancelled = false
    setBrowserStatus('opening')
    openE2BDashboardInBrowser()
      .then(opened => {
        if (cancelled) return
        setBrowserStatus(opened ? 'opened' : 'fallback')
      })
      .catch(() => {
        if (!cancelled) setBrowserStatus('fallback')
      })
    return () => {
      cancelled = true
    }
  }, [method])

  useInput(
    (
      _input: string,
      key: {
        return?: boolean
        escape?: boolean
        upArrow?: boolean
        downArrow?: boolean
      },
    ) => {
      if (state.step === 'success') return
      if (method) {
        if (key.escape) {
          setMethod(null)
          setState({ step: 'input' })
        }
        return
      }
      if (key.escape) {
        onDone(false)
        return
      }
      if (key.upArrow) {
        setSelectedMethodIndex(i =>
          i > 0 ? i - 1 : E2B_SECURITY_LOGIN_METHODS.length - 1,
        )
        return
      }
      if (key.downArrow) {
        setSelectedMethodIndex(i =>
          i < E2B_SECURITY_LOGIN_METHODS.length - 1 ? i + 1 : 0,
        )
        return
      }
      if (key.return) {
        const selected =
          E2B_SECURITY_LOGIN_METHODS[selectedMethodIndex]?.method ?? 'authLogin'
        setMethod(selected)
      }
    },
  )

  useEffect(() => {
    if (state.step !== 'success') return
    const timer = setTimeout(() => onDone(true), 800)
    return () => clearTimeout(timer)
  }, [onDone, state.step])

  function handleSubmit(value: string) {
    const secret = value.trim()
    if (!secret) {
      setState({ step: 'input', error: 'E2B credential cannot be empty.' })
      return
    }
    if (/\s/.test(secret)) {
      setState({
        step: 'input',
        error: 'E2B credentials should not contain spaces or newlines.',
      })
      return
    }

    saveE2BSecurityCredential(secret)
    if (!hasE2BSecurityAuth()) {
      setState({
        step: 'input',
        error: 'Saved, but Tau could not read the credential back. Check your settings file.',
      })
      return
    }
    setState({
      step: 'success',
      message: 'E2B credential saved. /safetest is ready to use.',
    })
  }

  return (
    <Dialog
      title={`Login - ${E2B_SECURITY_DISPLAY_NAME}`}
      onCancel={() => onDone(false)}
      color="permission"
    >
      <Box flexDirection="column" paddingLeft={1}>
        {!method && state.step === 'input' && (
          <>
            <Text dimColor>
              Choose how to sign in to E2B for /safetest.
            </Text>
            <Box flexDirection="column" marginTop={1}>
              {E2B_SECURITY_LOGIN_METHODS.map((option, index) => (
                <Text key={option.method}>
                  {index === selectedMethodIndex ? '>' : ' '} {option.label}{' '}
                  <Text dimColor>— {option.description}</Text>
                </Text>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Enter to choose, Esc to cancel</Text>
            </Box>
          </>
        )}
        {method && state.step === 'input' && (
          <>
            {method === 'authLogin' ? (
              <>
                <Text>
                  {browserStatus === 'opening'
                    ? 'Opening the E2B dashboard in your browser…'
                    : browserStatus === 'opened'
                    ? 'E2B dashboard opened in your browser.'
                    : 'Could not open a browser automatically.'}
                </Text>
                <Text dimColor>
                  Sign in (Google / GitHub / email), copy your API key from{' '}
                  <Text color="suggestion">{E2B_DASHBOARD_URL}</Text>, then paste it here.
                </Text>
              </>
            ) : (
              <>
                <Text>Paste your E2B API key.</Text>
                <Text dimColor>
                  Get one from <Text color="suggestion">{E2B_DASHBOARD_URL}</Text> if you don't have it yet.
                </Text>
              </>
            )}
            {state.error && (
              <Box marginTop={1}>
                <Text color="error">{state.error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text>E2B API key: </Text>
              <TextInput
                value={secretInput}
                onChange={setSecretInput}
                onSubmit={handleSubmit}
                mask="*"
                placeholder="Paste your E2B API key here..."
                focus={true}
                showCursor={true}
                columns={inputColumns}
                cursorOffset={secretCursorOffset}
                onChangeCursorOffset={setSecretCursorOffset}
              />
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Enter to save, Esc to go back</Text>
            </Box>
          </>
        )}
        {state.step === 'success' && (
          <Text color="success">{state.message}</Text>
        )}
      </Box>
    </Dialog>
  )
}

export function Login({
  onDone,
  startingMessage,
}: {
  onDone: (success: boolean) => void
  startingMessage?: string
}) {
  return (
    <Dialog
      title="Login"
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => onDone(true)}
        startingMessage={startingMessage}
      />
    </Dialog>
  )
}

function ThirdPartyLogin({
  provider,
  onDone,
}: {
  provider: APIProvider
  onDone: (success: boolean) => void
}) {
  const name = PROVIDER_DISPLAY_NAMES[provider]

  return (
    <Dialog
      title={`Login - ${name}`}
      onCancel={() => onDone(false)}
      color="permission"
      inputGuide={(exitState: { pending: boolean; keyName: string }) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ProviderLoginFlow provider={provider} onDone={onDone} />
    </Dialog>
  )
}
