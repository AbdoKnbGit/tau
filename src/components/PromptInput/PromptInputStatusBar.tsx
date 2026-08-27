import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useSettings } from '../../hooks/useSettings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { statusRowFits } from '../statusLineDisplay.js'
import { sessionStatusBarShouldDisplay } from '../StatusLine.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { analyzeContext } from '../../utils/contextAnalysis.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { getCwd } from '../../utils/cwd.js'
import { modelDisplayStringForProvider } from '../../utils/model/display.js'
import {
  getAPIProvider,
  isThirdPartyProvider,
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'
import {
  calculateConsumedContextPercentage,
  formatSessionStatus,
  shortenSessionCwd,
  type SessionQuotaStatus,
} from './sessionStatus.js'
import {
  buildProviderQuotaInput,
  providerReportsNoQuota,
} from '../../services/api/providerRateLimits.js'
import {
  ensureProviderQuotaFresh,
  getProviderQuotaOutcome,
  providerHasAccountQuota,
  subscribeProviderQuota,
} from '../../services/api/providerQuotaCache.js'
import { getRawUtilization } from '../../services/claudeAiLimits.js'
import { getTotalCost } from '../../cost-tracker.js'
import {
  isFlatFeeProvider,
  isLocalProvider,
} from '../../utils/modelPricingCatalog.js'

/**
 * Quota standing for the active provider.
 *
 * Third-party numbers come from response headers of calls this session already
 * made, so they exist only after the first turn on the current provider and
 * only for providers that publish `x-ratelimit-*`. Where a provider reports
 * both a request and a token window, the one nearer its ceiling is the one
 * worth surfacing.
 *
 * Anthropic's 5-hour window is NOT a general fallback: it describes the
 * Claude.ai subscription, not whatever provider the session is on. Showing it
 * beside a third-party model would label someone else's limit as this
 * provider's, so it applies only when the session really is on Anthropic.
 */
function resolveQuota(
  provider: APIProvider,
  activeModel: string,
): SessionQuotaStatus | null {
  // 1. Response headers. Free, already collected, and the freshest thing
  //    available - it came off the last call this session made.
  const harvested = buildProviderQuotaInput(provider)
  const windows = [harvested?.requests, harvested?.tokens]
    .map(window => window?.used_percentage)
    .filter((value): value is number => value !== undefined)
  if (windows.length > 0) {
    return { state: 'used', percentage: Math.max(...windows) }
  }

  // 2. Anthropic's 5-hour session window, which arrives the same free way.
  //    It describes the Claude.ai subscription, so it applies only when the
  //    session really is on Anthropic - never as a stand-in for a third party.
  //
  //    Absence here is not an answer: these headers only reach subscription
  //    sessions, so an API-key session on Anthropic has to fall through to the
  //    account lookup below like every other provider.
  if (!isThirdPartyProvider(provider)) {
    const fiveHour = getRawUtilization().five_hour
    if (fiveHour) return { state: 'used', percentage: fiveHour.utilization * 100 }
  }

  // 3. The provider's own account endpoint - credits, balance, utilization.
  //    Already refreshed off the render path by the effect below.
  const outcome = getProviderQuotaOutcome(provider, activeModel)
  if (outcome?.kind === 'reading') {
    if (outcome.usedPercent !== null) {
      return { state: 'used', percentage: outcome.usedPercent }
    }
    // A prepaid balance has no percentage until a budget supplies the total,
    // but the amount left is exactly what the row is being asked for.
    if (outcome.summary) return { state: 'text', text: outcome.summary }
  }
  // 4. No quota anywhere. Several providers publish none at all, and for
  //    those the useful question is not "how much is left?" but "what has
  //    this cost?" - which token prices can answer even when the platform
  //    shows nothing.
  //    Local providers are skipped: this is the session total across every
  //    model used, so showing it beside a local model would attribute money
  //    to inference that was free.
  const spend = isLocalProvider(provider) ? 0 : getTotalCost()
  if (spend > 0) {
    return { state: 'spend', usd: spend, estimated: isFlatFeeProvider(provider) }
  }

  // 'absent' or 'unconfigured': the lookup settled with no number to give.
  if (outcome) return { state: 'unavailable' }

  // 5. A provider with no account source at all, whose responses carried no
  //    rate limit headers either. Nothing further will arrive.
  if (
    !providerHasAccountQuota(provider) &&
    providerReportsNoQuota(provider)
  ) {
    return { state: 'unavailable' }
  }

  // Still pending: never fetched, in flight, or a reading gone too stale to
  // stand behind. A failure to learn the quota is not an absence of quota.
  return null
}

/** How often a visible bar may reconsider whether a refresh is due. */
const QUOTA_TICK_MS = 60_000

type Props = {
  messages: Parameters<typeof analyzeContext>[0]
  columns: number
}

export function PromptInputStatusBar({
  messages,
  columns,
}: Props): React.ReactNode {
  // Hidden when the user runs a custom statusLine command instead, or turns
  // the bar off with sessionStatusBar: false. See statusLineDisplay.ts.
  const settings = useSettings()
  const { rows } = useTerminalSize()
  const visible =
    sessionStatusBarShouldDisplay(settings) &&
    statusRowFits(isFullscreenEnvEnabled(), rows)
  const mainLoopModel = useMainLoopModel()
  const provider = getAPIProvider()
  const contextWindow = getContextWindowForModel(mainLoopModel, getSdkBetas())
  const lastMessageCount = messages.length
  const usedContextTokens = React.useMemo(() => {
    // Skip the scan entirely while hidden - it walks every message.
    if (!visible) return null
    try {
      // Count only conversation content that consumes the initially free
      // portion of the window. System prompts, tool schemas, and skill
      // frontmatter are injected separately and are deliberately excluded.
      return analyzeContext(messages).total
    } catch {
      // A status-only estimate must never make the prompt unusable.
      return null
    }
  }, [messages, visible])

  // Kept off the render path: this starts an account lookup at most once per
  // TTL and returns immediately, so the row always paints from what is already
  // cached. Gated on visibility, which is what keeps a piped or headless run
  // from issuing provider requests it will never display.
  // A quota that never moves reads as broken. Refresh is still gated by TTL,
  // backoff and the in-flight guard inside ensureProviderQuotaFresh - this tick
  // only gives it the chance to run, and only while the row is on screen.
  const [tick, advanceTick] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => {
    if (!visible) return
    const id = setInterval(advanceTick, QUOTA_TICK_MS)
    return () => clearInterval(id)
  }, [visible])

  React.useEffect(() => {
    if (!visible) return
    ensureProviderQuotaFresh(provider)
  }, [visible, provider, lastMessageCount, tick])

  // The lookup resolves well after the render that started it, and a
  // module-level cache cannot tell React it changed. Repaint when one lands.
  const [, onQuotaReading] = React.useReducer((count: number) => count + 1, 0)
  React.useEffect(() => subscribeProviderQuota(onQuotaReading), [onQuotaReading])
  // Every hook above runs unconditionally; the rest is plain formatting work
  // there is no reason to do while the bar is hidden.
  if (!visible) return null

  const cwd = shortenSessionCwd(getCwd())
  const status = formatSessionStatus(
    {
      cwd,
      provider: PROVIDER_DISPLAY_NAMES[provider],
      model: modelDisplayStringForProvider(mainLoopModel, provider),
      usedContextTokens,
      contextWindowTokens: contextWindow,
      consumedContextPercentage:
        usedContextTokens === null
          ? null
          : calculateConsumedContextPercentage(usedContextTokens, contextWindow),
      quota: resolveQuota(provider, mainLoopModel),
    },
    columns,
  )
  if (!status) return null

  return (
    <Box flexDirection="row" paddingX={2} flexShrink={0} overflowX="hidden">
      <Text color="textMuted" dimColor wrap="truncate">
        {status}
      </Text>
    </Box>
  )
}
