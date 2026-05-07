/**
 * First-run provider setup — shown during onboarding when no AI provider
 * has any credentials yet. Picks a provider, then hands off to the
 * existing ProviderLoginFlow (OAuth or API key paste) so the user never
 * needs to know about environment variables.
 */

import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { ProviderLoginFlow } from './ProviderLoginFlow.js'
import type { APIProvider } from '../utils/model/providers.js'
import {
  PROVIDER_DISPLAY_NAMES,
  setActiveProvider,
} from '../utils/model/providers.js'
import { hasAnyThirdPartyProviderConfigured } from '../services/api/auth/api_key_manager.js'
import {
  getClaudeAIOAuthTokens,
  hasAnthropicApiKeyAuth,
} from '../utils/auth.js'

type Props = {
  onDone: () => void
}

type PickerState =
  | { step: 'picker' }
  | { step: 'login'; provider: APIProvider }

/**
 * Returns true when at least one provider (first-party or third-party)
 * has credentials stored. When false, the first-run wizard should appear
 * so the user never sees a "no provider" error at the first prompt.
 */
export function hasAnyAuthConfigured(): boolean {
  if (hasAnyThirdPartyProviderConfigured()) return true
  if (hasAnthropicApiKeyAuth()) return true
  if (getClaudeAIOAuthTokens()?.accessToken) return true
  return false
}

/**
 * A short list of providers surfaced on the first-run screen. Ordered by
 * ease-of-setup for non-technical users: Anthropic first (subscription +
 * OAuth), then OpenAI/Gemini (OAuth or key), then Ollama (local, zero-
 * config if installed), then "See all providers" which falls through to
 * the full /provider picker.
 */
const FEATURED_PROVIDERS: APIProvider[] = [
  'firstParty',
  'openai',
  'gemini',
  'ollama',
  'openrouter',
  'deepseek',
  'moonshot',
  'minimax',
  'groq',
  'nim',
]

export function FirstRunProviderSetup({ onDone }: Props): React.ReactNode {
  const [state, setState] = useState<PickerState>({ step: 'picker' })

  if (state.step === 'login') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <ProviderLoginFlow
          provider={state.provider}
          onDone={(success: boolean) => {
            if (success) {
              setActiveProvider(state.provider)
              // Let the user see the login-success screen briefly before
              // onboarding advances. ProviderLoginFlow has its own 1s
              // delay before calling onDone, so we can advance immediately.
              onDone()
            } else {
              setState({ step: 'picker' })
            }
          }}
        />
      </Box>
    )
  }

  const options = FEATURED_PROVIDERS.map(provider => ({
    label: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    value: provider,
  }))
  options.push({ label: 'Skip — I\'ll set this up later', value: 'skip' as APIProvider })

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Connect an AI provider</Text>
      <Box flexDirection="column" width={70}>
        <Text dimColor>
          Tau works with multiple AI providers. Pick one to get started —
          we&apos;ll store the credentials locally so you never have to set
          environment variables.
        </Text>
      </Box>
      <Select
        options={options}
        onChange={value => {
          if (value === 'skip') {
            onDone()
            return
          }
          setState({ step: 'login', provider: value as APIProvider })
        }}
        onCancel={onDone}
      />
    </Box>
  )
}
