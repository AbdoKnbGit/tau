import { getOpenAISessionToken } from './auth/openai_oauth.js'
import {
  getClineOAuthToken,
  getKiloCodeOAuthToken,
  getValidCopilotOAuthToken,
  getValidCursorOAuthToken,
  getValidKiroOAuthToken,
} from './auth/oauth_services.js'
import { getGeminiOAuthToken } from './auth/google_oauth.js'
import { loadProviderKey } from './auth/api_key_manager.js'
import {
  CODE_ASSIST_BASE,
  antigravityApiHeaders,
  ensureCodeAssistReady,
  fetchGeminiCliQuotaBuckets,
  getGeminiTier,
  type GeminiQuotaBucket,
} from './providers/gemini_code_assist.js'
import { ANTIGRAVITY_API_VERSION } from '../../constants/antigravity.js'
import { fetchUtilization, type Utilization } from './usage.js'
import {
  loadStore,
  refreshAccessToken,
  saveStore,
  type AntigravityAccount,
} from '../../lanes/shared/antigravity_auth.js'
import {
  getClaudeAIOAuthTokens,
  getProviderBaseUrl,
  getProviderApiKey,
  getSubscriptionType,
} from '../../utils/auth.js'
import {
  PROVIDER_DISPLAY_NAMES,
  type APIProvider,
} from '../../utils/model/providers.js'

const TIMEOUT_MS = 8_000
const ANTIGRAVITY_USAGE_MODEL_KEYS = [
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'gemini-3-flash',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gpt-oss-120b-medium',
] as const
const DOCS = {
  anthropic: 'https://platform.claude.com/docs/en/build-with-claude/usage-cost-api',
  openai: 'https://platform.openai.com/docs/api-reference/usage/costs',
  openrouter: 'https://openrouter.ai/docs/api-reference/credits/get-credits',
  deepseek: 'https://api-docs.deepseek.com/api/get-user-balance/',
  glm: 'https://bigmodel.cn/finance/expensebill/list',
  moonshot: 'https://platform.kimi.ai/docs/api/balance',
  minimax: 'https://platform.minimax.io/docs/token-plan/faq',
  cursor: 'https://docs.cursor.com/en/account/teams/admin-api',
  copilot: 'https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics',
} as const

export type ProviderUsageStatus =
  | 'ok'
  | 'connected'
  | 'not_configured'
  | 'unsupported'
  | 'error'

export type UsageAuthMethod =
  | 'oauth'
  | 'api_key'
  | 'admin_api_key'
  | 'local'
  | 'none'

export type ProviderUsageId = APIProvider | 'codex'

export type UsageMetric = {
  label: string
  usedPercent?: number
  summary?: string
  detail?: string
  resetsAt?: string | null
}

export type UsageLink = {
  label: string
  url: string
  note?: string
}

export type ProviderUsageReport = {
  provider: ProviderUsageId
  name: string
  status: ProviderUsageStatus
  auth: UsageAuthMethod
  source: string
  summary: string
  detail?: string
  metrics?: UsageMetric[]
  docsUrl?: string
  links?: UsageLink[]
}

export type ProviderUsageSnapshot = {
  refreshedAt: string
  reports: ProviderUsageReport[]
}

type StoredOAuthBlob = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  meta?: Record<string, unknown>
}

type Reporter = () => Promise<ProviderUsageReport>

export async function fetchAllProviderUsage(): Promise<ProviderUsageSnapshot> {
  const reports = await Promise.all(REPORTERS.map(runReporter))
  return {
    refreshedAt: new Date().toISOString(),
    reports,
  }
}

const REPORTERS: Reporter[] = [
  reportAnthropic,
  reportOpenAI,
  reportGemini,
  reportAntigravity,
  reportOpenRouter,
  reportDeepSeek,
  reportGLM,
  reportMoonshot,
  reportMiniMax,
  reportOllama,
  reportCline,
  reportCopilot,
  reportCursor,
  reportKiloCode,
  reportKiro,
]

async function runReporter(reporter: Reporter): Promise<ProviderUsageReport> {
  try {
    return await reporter()
  } catch (error) {
    const fallback = inferFallbackReport(reporter)
    return {
      ...fallback,
      status: 'error',
      summary: messageFromError(error),
    }
  }
}

function inferFallbackReport(reporter: Reporter): ProviderUsageReport {
  const name = reporter.name.replace(/^report/, '').toLowerCase()
  const provider = nameToProvider(name)
  return baseReport(provider, 'error', 'none', 'Official API', 'Failed to fetch usage.')
}

function nameToProvider(name: string): ProviderUsageId {
  switch (name) {
    case 'anthropic': return 'firstParty'
    case 'openai': return 'openai'
    case 'gemini': return 'gemini'
    case 'antigravity': return 'antigravity'
    case 'openrouter': return 'openrouter'
    case 'groq': return 'groq'
    case 'nim': return 'nim'
    case 'deepseek': return 'deepseek'
    case 'glm': return 'glm'
    case 'moonshot': return 'moonshot'
    case 'minimax': return 'minimax'
    case 'ollama': return 'ollama'
    case 'cline': return 'cline'
    case 'copilot': return 'copilot'
    case 'cursor': return 'cursor'
    case 'iflow': return 'iflow'
    case 'kilocode': return 'kilocode'
    case 'kiro': return 'kiro'
    case 'bedrock': return 'bedrock'
    case 'vertex': return 'vertex'
    case 'foundry': return 'foundry'
    default: return 'codex'
  }
}

async function reportAnthropic(): Promise<ProviderUsageReport> {
  const metrics: UsageMetric[] = []
  const details: string[] = []
  const tokens = getClaudeAIOAuthTokens()
  const subscriptionType = getSubscriptionType()

  if (tokens) {
    const utilization = await fetchUtilization().catch((error) => {
      details.push(`Claude subscription usage unavailable: ${messageFromError(error)}`)
      return null
    })
    metrics.push(...metricsFromAnthropicUtilization(utilization, subscriptionType))
  }

  const adminKey = getEnv('ANTHROPIC_ADMIN_API_KEY', 'ANTHROPIC_ADMIN_KEY')
  if (adminKey) {
    const apiCost = await fetchAnthropicAdminCost(adminKey)
    metrics.push(apiCost.metric)
    details.push(apiCost.summary)
  }

  if (metrics.length === 0) {
    return {
      ...baseReport(
        'firstParty',
        tokens ? 'connected' : 'not_configured',
        tokens ? 'oauth' : 'none',
        'Claude OAuth / Admin API',
        tokens
          ? 'Claude OAuth is connected, but no subscription usage bars were returned.'
          : 'Sign in with Anthropic for Claude subscription usage.',
      ),
      detail: adminKey
        ? details.join(' ')
        : 'For Anthropic Console API costs, set ANTHROPIC_ADMIN_API_KEY.',
      docsUrl: DOCS.anthropic,
    }
  }

  return {
    ...baseReport(
      'firstParty',
      'ok',
      adminKey ? 'admin_api_key' : 'oauth',
      adminKey ? 'Claude OAuth + Admin API' : 'Claude OAuth',
      'Fetched Anthropic subscription and/or Console API usage.',
    ),
    detail: details.join(' ') || undefined,
    metrics,
    docsUrl: DOCS.anthropic,
  }
}

async function reportOpenAI(): Promise<ProviderUsageReport> {
  const metrics: UsageMetric[] = []
  const details: string[] = []
  const sessionToken = getOpenAISessionToken()
  const adminKey = getEnv('OPENAI_ADMIN_KEY', 'OPENAI_ORG_ADMIN_KEY')
  const configuredApiKey = getProviderApiKey('openai')

  if (sessionToken) {
    const codexData = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        Accept: 'application/json',
      },
    })
    const codexMetrics = parseCodexUsage(codexData)
    metrics.push(...codexMetrics)
    details.push('ChatGPT/Codex quota fetched from the same backend used by Codex.')
  }

  if (adminKey) {
    const openAICost = await fetchOpenAICosts(adminKey)
    metrics.push(openAICost.metric)
    details.push(openAICost.summary)
  } else if (configuredApiKey) {
    details.push('OpenAI API key is configured; org costs require OPENAI_ADMIN_KEY.')
  }

  if (metrics.length === 0) {
    return {
      ...baseReport(
        'openai',
        configuredApiKey || sessionToken ? 'connected' : 'not_configured',
        sessionToken ? 'oauth' : configuredApiKey ? 'api_key' : 'none',
        'ChatGPT usage / OpenAI org costs',
        configuredApiKey || sessionToken
          ? 'Connected, but no official usage meter is available with the current credential.'
          : 'Connect OpenAI OAuth or set an API/admin key.',
      ),
      detail: details.join(' '),
      docsUrl: DOCS.openai,
    }
  }

  return {
    ...baseReport(
      'openai',
      'ok',
      adminKey ? 'admin_api_key' : 'oauth',
      adminKey ? 'ChatGPT + OpenAI Admin API' : 'ChatGPT backend',
      'Fetched OpenAI/Codex usage.',
    ),
    detail: details.join(' '),
    metrics,
    docsUrl: DOCS.openai,
  }
}

async function reportGemini(): Promise<ProviderUsageReport> {
  const accessToken = await getGeminiOAuthToken('cli')
  if (!accessToken) {
    return baseReport(
      'gemini',
      'not_configured',
      'none',
      'Google Code Assist',
      'No Gemini OAuth is connected. Run `/login` to authorize the CLI flow.',
    )
  }

  let projectId: string | null = null
  try {
    projectId = await ensureCodeAssistReady(accessToken, 'cli')
  } catch (error) {
    return {
      ...baseReport(
        'gemini',
        'connected',
        'oauth',
        'Google Code Assist',
        'Gemini is connected, but Code Assist onboarding failed.',
      ),
      detail: messageFromError(error),
    }
  }

  if (!projectId) {
    return baseReport(
      'gemini',
      'connected',
      'oauth',
      'Google Code Assist',
      'Gemini is connected, but no Cloud project is bound to the account yet.',
    )
  }

  const buckets = await fetchGeminiCliQuotaBuckets(accessToken, projectId)
  if (!buckets || buckets.length === 0) {
    return {
      ...baseReport(
        'gemini',
        'connected',
        'oauth',
        'Google Code Assist',
        'Gemini is connected, but the quota response did not include model usage.',
      ),
      detail: 'Free-tier accounts sometimes get an empty buckets array; the picker still routes to flash/lite.',
    }
  }

  const metrics = parseGeminiCliQuota(buckets)
  if (metrics.length === 0) {
    return baseReport(
      'gemini',
      'connected',
      'oauth',
      'Google Code Assist',
      'Gemini quota returned but no per-model usage was parseable.',
    )
  }

  const tier = getGeminiTier('cli')
  const tierNote = tier ? ` Tier: ${tier}.` : ''

  return {
    ...baseReport(
      'gemini',
      'ok',
      'oauth',
      'Google Code Assist',
      'Fetched per-tier model quota from retrieveUserQuota.',
    ),
    detail: `Project: ${projectId}.${tierNote} Usage is calculated per tier from buckets[].remainingFraction.`,
    metrics,
  }
}

/**
 * Group Code Assist quota buckets into tier-level rows (Pro / Flash /
 * Flash Lite), mirroring gemini-cli's ModelQuotaDisplay grouping.
 *
 * For each tier we keep the bucket with the LOWEST `remainingFraction`
 * — i.e. the most-used bucket in that tier. This matches gemini-cli's
 * "show the binding-rate-limit row per tier" rule. Ungrouped models
 * (no tier match) fall through under their raw modelId so users still
 * see them.
 */
function parseGeminiCliQuota(buckets: GeminiQuotaBucket[]): UsageMetric[] {
  const TIER_DISPLAY: Record<string, { label: string; order: number }> = {
    pro:          { label: 'Pro',         order: 0 },
    flash:        { label: 'Flash',       order: 1 },
    'flash-lite': { label: 'Flash Lite',  order: 2 },
  }

  type Row = {
    tier: string
    label: string
    order: number
    remainingFraction: number
    resetTime?: string
  }

  const grouped = new Map<string, Row>()
  for (const bucket of buckets) {
    const modelId = typeof bucket.modelId === 'string' ? bucket.modelId.trim() : ''
    if (!modelId) continue
    const remainingFraction = readNumber(bucket.remainingFraction)
    if (remainingFraction === null) continue

    const tier = classifyGeminiModelTier(modelId)
    const meta = TIER_DISPLAY[tier]
    const tierKey = meta ? tier : modelId
    const label = meta?.label ?? modelId
    const order = meta?.order ?? 99

    const existing = grouped.get(tierKey)
    if (!existing || remainingFraction < existing.remainingFraction) {
      grouped.set(tierKey, {
        tier: tierKey,
        label,
        order,
        remainingFraction,
        resetTime: validFutureIso(readString(bucket.resetTime)) ?? undefined,
      })
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(row => ({
      label: row.label,
      usedPercent: clampPercent((1 - row.remainingFraction) * 100),
      summary: `${Math.round(clampPercent(row.remainingFraction * 100))}% remaining`,
      resetsAt: row.resetTime,
    }))
}

/**
 * Map a Gemini model id to one of the `pro` / `flash` / `flash-lite`
 * tiers used by gemini-cli's quota display. Returns the raw modelId
 * for anything that doesn't match (image gen, embeddings) so the
 * picker still surfaces it ungrouped.
 */
function classifyGeminiModelTier(modelId: string): string {
  const lower = modelId.toLowerCase()
  // Order matters: flash-lite must beat flash; pro must beat flash on
  // ids like `gemini-3-pro-preview` (no flash substring) but lose to
  // flash-lite when the id literally contains both (none today, but
  // cheap insurance against future drift).
  if (lower.includes('flash-lite')) return 'flash-lite'
  if (lower.includes('flash')) return 'flash'
  if (lower.includes('pro')) return 'pro'
  return modelId
}

async function reportAntigravity(): Promise<ProviderUsageReport> {
  const account = await getAntigravityAccount()
  const oauthToken = account ? null : await getGeminiOAuthToken('antigravity')
  const accessToken = account?.accessToken ?? oauthToken

  if (!accessToken) {
    return baseReport(
      'antigravity',
      'not_configured',
      'none',
      'Google Code Assist',
      'No Antigravity account is connected.',
    )
  }

  const project = account?.projectId ?? await ensureAntigravityProject(accessToken)
  let data: unknown
  try {
    data = await fetchAntigravityAvailableModels(accessToken, project)
  } catch (error) {
    return {
      ...baseReport(
        'antigravity',
        'connected',
        'oauth',
        'Google Code Assist',
        'Antigravity is connected, but the quota request failed.',
      ),
      detail: messageFromError(error),
    }
  }
  const metrics = parseAntigravityUsage(data)
  const accountLabel = account?.email ?? 'Antigravity OAuth'

  if (metrics.length === 0) {
    return {
      ...baseReport(
        'antigravity',
        'connected',
        'oauth',
        'Google Code Assist',
        'Antigravity is connected, but the quota response did not include model usage.',
      ),
      detail: `Account: ${accountLabel}`,
    }
  }

  return {
    ...baseReport(
      'antigravity',
      'ok',
      'oauth',
      'Google Code Assist',
      'Fetched model quota remaining from Antigravity.',
    ),
    detail: `Account: ${accountLabel}. Usage is calculated per model from quotaInfo.remainingFraction.`,
    metrics,
  }
}

async function reportOpenRouter(): Promise<ProviderUsageReport> {
  const apiKey = getProviderApiKey('openrouter')
  if (!apiKey) {
    return {
      ...baseReport(
        'openrouter',
        'not_configured',
        'none',
        'OpenRouter credits',
        'No OpenRouter API key is configured.',
      ),
      docsUrl: DOCS.openrouter,
    }
  }

  const data = await fetchJson('https://openrouter.ai/api/v1/credits', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  const credits = parseOpenRouterCredits(data)
  if (!credits) {
    return {
      ...baseReport(
        'openrouter',
        'error',
        'api_key',
        'OpenRouter credits',
        'OpenRouter returned an unrecognized credits response.',
      ),
      docsUrl: DOCS.openrouter,
    }
  }

  return {
    ...baseReport(
      'openrouter',
      'ok',
      'api_key',
      'OpenRouter credits',
      `${formatCurrency(credits.used, 'USD')} used, ${formatCurrency(credits.remaining, 'USD')} remaining.`,
    ),
    metrics: [{
      label: 'Credits',
      usedPercent: credits.total > 0 ? clampPercent(credits.used / credits.total * 100) : undefined,
      summary: `${formatCurrency(credits.used, 'USD')} / ${formatCurrency(credits.total, 'USD')} used`,
    }],
    docsUrl: DOCS.openrouter,
  }
}

async function reportDeepSeek(): Promise<ProviderUsageReport> {
  const apiKey = getProviderApiKey('deepseek')
  if (!apiKey) {
    return {
      ...baseReport(
        'deepseek',
        'not_configured',
        'none',
        'DeepSeek balance',
        'No DeepSeek API key is configured.',
      ),
      docsUrl: DOCS.deepseek,
    }
  }

  const data = await fetchJson('https://api.deepseek.com/user/balance', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  const balances = parseDeepSeekBalances(data)
  if (balances.length === 0) {
    return {
      ...baseReport(
        'deepseek',
        'error',
        'api_key',
        'DeepSeek balance',
        'DeepSeek returned an unrecognized balance response.',
      ),
      docsUrl: DOCS.deepseek,
    }
  }

  const metrics = balances.map((balance) => {
    const budget = getBudget(`CLAUDEX_USAGE_DEEPSEEK_BUDGET_${balance.currency}`, 'DEEPSEEK_MONTHLY_BUDGET_USD')
    const used = budget ? Math.max(0, budget - balance.total) : null
    return {
      label: `${balance.currency} balance`,
      usedPercent: budget && used !== null ? clampPercent(used / budget * 100) : undefined,
      summary: budget && used !== null
        ? `${formatCurrency(used, balance.currency)} / ${formatCurrency(budget, balance.currency)} budget used`
        : `${formatCurrency(balance.total, balance.currency)} remaining`,
      detail: `${formatCurrency(balance.granted, balance.currency)} granted, ${formatCurrency(balance.toppedUp, balance.currency)} topped up`,
    }
  })

  return {
    ...baseReport(
      'deepseek',
      'ok',
      'api_key',
      'DeepSeek balance',
      balances.map((balance) => `${formatCurrency(balance.total, balance.currency)} ${balance.currency} remaining`).join(', '),
    ),
    detail: 'Set CLAUDEX_USAGE_DEEPSEEK_BUDGET_USD to turn remaining balance into a percent-used bar.',
    metrics,
    docsUrl: DOCS.deepseek,
  }
}

async function reportGLM(): Promise<ProviderUsageReport> {
  const apiKey = getProviderApiKey('glm')
  if (!apiKey) {
    return {
      ...baseReport(
        'glm',
        'not_configured',
        'none',
        'BigModel usage',
        'No GLM API key is configured.',
      ),
      docsUrl: DOCS.glm,
      links: [{
        label: 'BigModel API keys',
        url: 'https://open.bigmodel.cn/usercenter/apikeys',
      }],
    }
  }

  return {
    ...baseReport(
      'glm',
      'connected',
      'api_key',
      'BigModel usage',
      'GLM API key is configured.',
    ),
    detail: 'BigModel usage and balance are available in the BigModel console; no public balance API is documented.',
    docsUrl: DOCS.glm,
    links: [
      {
        label: 'BigModel API keys',
        url: 'https://open.bigmodel.cn/usercenter/apikeys',
      },
      {
        label: 'BigModel expense bill',
        url: 'https://bigmodel.cn/finance/expensebill/list',
      },
    ],
  }
}

async function reportMoonshot(): Promise<ProviderUsageReport> {
  const apiKey = getProviderApiKey('moonshot')
  if (!apiKey) {
    return {
      ...baseReport(
        'moonshot',
        'not_configured',
        'none',
        'Moonshot balance',
        'No Moonshot API key is configured.',
      ),
      docsUrl: DOCS.moonshot,
      links: [{
        label: 'Moonshot API keys',
        url: 'https://platform.kimi.ai/console/api-keys',
      }],
    }
  }

  const baseUrl = getProviderBaseUrl('moonshot').replace(/\/+$/, '')
  const data = await fetchJson(`${baseUrl}/users/me/balance`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  })
  const balance = parseMoonshotBalance(data)
  if (!balance) {
    return {
      ...baseReport(
        'moonshot',
        'error',
        'api_key',
        'Moonshot balance',
        'Moonshot returned an unrecognized balance response.',
      ),
      docsUrl: DOCS.moonshot,
    }
  }

  const budget = getBudget(
    `CLAUDEX_USAGE_MOONSHOT_BUDGET_${balance.currency}`,
    'CLAUDEX_USAGE_MOONSHOT_BUDGET_CNY',
    'MOONSHOT_MONTHLY_BUDGET_CNY',
  )
  const used = budget ? Math.max(0, budget - balance.available) : null
  const detailParts = [
    balance.cash !== null ? `${formatCurrency(balance.cash, balance.currency)} cash` : null,
    balance.voucher !== null ? `${formatCurrency(balance.voucher, balance.currency)} voucher` : null,
  ].filter((part): part is string => part !== null)

  return {
    ...baseReport(
      'moonshot',
      'ok',
      'api_key',
      'Moonshot balance',
      `${formatCurrency(balance.available, balance.currency)} available.`,
    ),
    detail: 'Set CLAUDEX_USAGE_MOONSHOT_BUDGET_CNY to turn remaining balance into a percent-used bar.',
    metrics: [{
      label: `${balance.currency} balance`,
      usedPercent: budget && used !== null ? clampPercent(used / budget * 100) : undefined,
      summary: budget && used !== null
        ? `${formatCurrency(used, balance.currency)} / ${formatCurrency(budget, balance.currency)} budget used`
        : `${formatCurrency(balance.available, balance.currency)} available`,
      detail: detailParts.length > 0 ? detailParts.join(', ') : undefined,
    }],
    docsUrl: DOCS.moonshot,
  }
}

async function reportMiniMax(): Promise<ProviderUsageReport> {
  const apiKey = getProviderApiKey('minimax')
  const links: UsageLink[] = [
    {
      label: 'MiniMax API keys',
      url: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    },
    {
      label: 'MiniMax Token Plan',
      url: 'https://platform.minimax.io/user-center/payment/coding-plan',
    },
  ]

  if (!apiKey) {
    return {
      ...baseReport(
        'minimax',
        'not_configured',
        'none',
        'MiniMax Token Plan remains',
        'No MiniMax API key is configured.',
      ),
      docsUrl: DOCS.minimax,
      links,
    }
  }

  let data: unknown
  try {
    data = await fetchMiniMaxUsage(apiKey)
  } catch (error) {
    return {
      ...baseReport(
        'minimax',
        'error',
        'api_key',
        'MiniMax Token Plan remains',
        'MiniMax usage API request failed.',
      ),
      detail: messageFromError(error),
      docsUrl: DOCS.minimax,
      links,
    }
  }

  const parsed = parseMiniMaxUsage(data)
  if (!parsed) {
    return {
      ...baseReport(
        'minimax',
        'error',
        'api_key',
        'MiniMax Token Plan remains',
        'MiniMax returned an unrecognized usage response.',
      ),
      docsUrl: DOCS.minimax,
      links,
    }
  }

  return {
    ...baseReport(
      'minimax',
      'ok',
      'api_key',
      'MiniMax Token Plan remains',
      parsed.summary,
    ),
    detail: parsed.detail,
    metrics: parsed.metrics,
    docsUrl: DOCS.minimax,
    links,
  }
}

async function reportOllama(): Promise<ProviderUsageReport> {
  return {
    ...baseReport(
      'ollama',
      'ok',
      'local',
      'Local runtime',
      'Ollama runs locally and has no remote billing API.',
    ),
    links: [{
      label: 'Ollama settings',
      url: 'https://ollama.com/settings',
    }],
  }
}

async function reportCline(): Promise<ProviderUsageReport> {
  const token = getClineOAuthToken()
  return {
    ...baseReport(
      'cline',
      token ? 'connected' : 'not_configured',
      token ? 'oauth' : 'none',
      'Cline account',
      token
        ? 'Cline OAuth is connected; usage is available in the Cline dashboard.'
        : 'No Cline OAuth token is configured.',
    ),
    links: [{
      label: 'Cline dashboard',
      url: 'https://app.cline.bot/dashboard',
    }],
  }
}

async function reportCopilot(): Promise<ProviderUsageReport> {
  const token = await getValidCopilotOAuthToken()
  const stored = readStoredOAuth('copilot_oauth')
  const metrics = copilotMetricsFromStoredPlan(stored)
  const githubToken = getEnv('GITHUB_TOKEN', 'GH_TOKEN')
  const org = getEnv('GITHUB_COPILOT_ORG')

  if (githubToken && org) {
    const remote = await fetchGithubCopilotMetrics(githubToken, org)
    metrics.push(remote)
  }

  if (metrics.length > 0) {
    return {
      ...baseReport(
        'copilot',
        'ok',
        githubToken && org ? 'admin_api_key' : 'oauth',
        githubToken && org ? 'GitHub Copilot metrics API' : 'Stored Copilot entitlement',
        'Fetched Copilot usage information.',
      ),
      detail: githubToken && org
        ? `Organization metrics for ${org}.`
        : 'For official org metrics, set GITHUB_TOKEN and GITHUB_COPILOT_ORG.',
      metrics,
      docsUrl: DOCS.copilot,
      links: [{
        label: 'Premium requests usage',
        url: 'https://docs.github.com/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests',
        note: 'Premium users can see usage and entitlements here.',
      }],
    }
  }

  return {
    ...baseReport(
      'copilot',
      token ? 'connected' : 'not_configured',
      token ? 'oauth' : 'none',
      'GitHub Copilot metrics API',
      token
        ? 'Copilot is connected; official usage metrics require an org/enterprise GitHub token.'
        : 'No Copilot token is configured.',
    ),
    detail: 'Set GITHUB_TOKEN and GITHUB_COPILOT_ORG to fetch official Copilot metrics.',
    docsUrl: DOCS.copilot,
    links: [{
      label: 'Premium requests usage',
      url: 'https://docs.github.com/copilot/managing-copilot/monitoring-usage-and-entitlements/about-premium-requests',
      note: 'Premium users can see usage and entitlements here.',
    }],
  }
}

async function reportCursor(): Promise<ProviderUsageReport> {
  const adminKey = getEnv('CURSOR_ADMIN_API_KEY')
  const oauth = getValidCursorOAuthToken()

  if (!adminKey) {
    return {
      ...baseReport(
        'cursor',
        oauth ? 'connected' : 'not_configured',
        oauth ? 'oauth' : 'none',
        'Cursor Admin API',
        oauth
          ? 'Cursor is connected; official team spend requires CURSOR_ADMIN_API_KEY.'
          : 'No Cursor OAuth token or admin key is configured.',
      ),
      detail: 'Cursor Admin API keys are created by team admins in the Cursor dashboard.',
      docsUrl: DOCS.cursor,
      links: [{
        label: 'Cursor usage dashboard',
        url: 'https://cursor.com/dashboard/usage',
      }],
    }
  }

  const spend = await fetchCursorSpend(adminKey)
  if (!spend) {
    return {
      ...baseReport(
        'cursor',
        'error',
        'admin_api_key',
        'Cursor Admin API',
        'Cursor returned an unrecognized spend response.',
      ),
      docsUrl: DOCS.cursor,
    }
  }

  return {
    ...baseReport(
      'cursor',
      'ok',
      'admin_api_key',
      'Cursor Admin API',
      spend.summary,
    ),
    metrics: spend.metric ? [spend.metric] : undefined,
    docsUrl: DOCS.cursor,
    links: [{
      label: 'Cursor usage dashboard',
      url: 'https://cursor.com/dashboard/usage',
    }],
  }
}

async function reportKiloCode(): Promise<ProviderUsageReport> {
  const token = getKiloCodeOAuthToken()
  return {
    ...baseReport(
      'kilocode',
      token ? 'connected' : 'not_configured',
      token ? 'oauth' : 'none',
      'KiloCode account',
      token
        ? 'KiloCode is connected; usage is available in the Kilo dashboard.'
        : 'No KiloCode OAuth token is configured.',
    ),
    links: [{
      label: 'Kilo usage dashboard',
      url: 'https://app.kilo.ai/usage',
    }],
  }
}

async function reportKiro(): Promise<ProviderUsageReport> {
  const token = await getValidKiroOAuthToken()
  if (!token) {
    return baseReport(
      'kiro',
      'not_configured',
      'none',
      'AWS CodeWhisperer usage limits',
      'No Kiro OAuth token is configured.',
    )
  }

  const data = await fetchKiroUsage(token)
  const metrics = parseKiroUsage(data)
  if (metrics.length === 0) {
    return baseReport(
      'kiro',
      'connected',
      'oauth',
      'AWS CodeWhisperer usage limits',
      'Kiro usage endpoint responded without quota details.',
    )
  }

  return {
    ...baseReport(
      'kiro',
      'ok',
      'oauth',
      'AWS CodeWhisperer usage limits',
      'Fetched Kiro quota from AWS usage limits.',
    ),
    metrics,
  }
}

function baseReport(
  provider: ProviderUsageId,
  status: ProviderUsageStatus,
  auth: UsageAuthMethod,
  source: string,
  summary: string,
): ProviderUsageReport {
  return {
    provider,
    name: displayName(provider),
    status,
    auth,
    source,
    summary,
  }
}

function displayName(provider: ProviderUsageId): string {
  if (provider === 'codex') return 'Codex'
  return PROVIDER_DISPLAY_NAMES[provider]
}

function metricsFromAnthropicUtilization(
  utilization: Utilization | null,
  subscriptionType: ReturnType<typeof getSubscriptionType>,
): UsageMetric[] {
  if (!utilization) return []
  const showSonnetBar = subscriptionType === 'max' || subscriptionType === 'team' || subscriptionType === null
  return [
    utilization.five_hour ? rateLimitMetric('Current session', utilization.five_hour) : null,
    utilization.seven_day ? rateLimitMetric('Current week (all models)', utilization.seven_day) : null,
    showSonnetBar && utilization.seven_day_sonnet
      ? rateLimitMetric('Current week (Sonnet only)', utilization.seven_day_sonnet)
      : null,
    utilization.seven_day_opus
      ? rateLimitMetric('Current week (Opus only)', utilization.seven_day_opus)
      : null,
    utilization.extra_usage ? extraUsageMetric(utilization.extra_usage) : null,
  ].filter((metric): metric is UsageMetric => metric !== null)
}

function rateLimitMetric(
  label: string,
  limit: { utilization: number | null; resets_at: string | null },
): UsageMetric | null {
  if (limit.utilization === null) return null
  return {
    label,
    usedPercent: clampPercent(limit.utilization),
    resetsAt: limit.resets_at,
  }
}

function extraUsageMetric(extraUsage: NonNullable<Utilization['extra_usage']>): UsageMetric | null {
  if (!extraUsage.is_enabled) {
    return {
      label: 'Extra usage',
      summary: 'Not enabled',
    }
  }
  if (extraUsage.monthly_limit === null) {
    return {
      label: 'Extra usage',
      summary: 'Unlimited',
    }
  }
  if (typeof extraUsage.used_credits !== 'number' || typeof extraUsage.utilization !== 'number') {
    return null
  }
  const used = extraUsage.used_credits / 100
  const limit = extraUsage.monthly_limit / 100
  return {
    label: 'Extra usage',
    usedPercent: clampPercent(extraUsage.utilization),
    summary: `${formatCurrency(used, 'USD')} / ${formatCurrency(limit, 'USD')} spent`,
    resetsAt: nextMonthIso(),
  }
}

async function fetchAnthropicAdminCost(adminKey: string): Promise<{ summary: string; metric: UsageMetric }> {
  const url = new URL('https://api.anthropic.com/v1/organizations/cost_report')
  url.searchParams.set('starting_at', monthStartIso())
  url.searchParams.set('ending_at', new Date().toISOString())
  const data = await fetchJson(url.toString(), {
    headers: {
      'anthropic-version': '2023-06-01',
      'x-api-key': adminKey,
      Accept: 'application/json',
    },
  })
  const cost = sumAnthropicCostCents(data)
  const budget = getBudget('CLAUDEX_USAGE_ANTHROPIC_BUDGET_USD', 'ANTHROPIC_MONTHLY_BUDGET_USD')
  const dollars = cost / 100
  return {
    summary: 'Anthropic Console API costs are month-to-date.',
    metric: {
      label: 'Console API cost',
      usedPercent: budget ? clampPercent(dollars / budget * 100) : undefined,
      summary: budget
        ? `${formatCurrency(dollars, 'USD')} / ${formatCurrency(budget, 'USD')} budget used`
        : `${formatCurrency(dollars, 'USD')} month-to-date`,
    },
  }
}

async function fetchOpenAICosts(adminKey: string): Promise<{ summary: string; metric: UsageMetric }> {
  const url = new URL('https://api.openai.com/v1/organization/costs')
  url.searchParams.set('start_time', String(monthStartEpochSeconds()))
  url.searchParams.set('bucket_width', '1d')
  url.searchParams.set('limit', '31')
  const data = await fetchJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${adminKey}`,
      Accept: 'application/json',
    },
  })
  const cost = sumOpenAICosts(data)
  const budget = getBudget('CLAUDEX_USAGE_OPENAI_BUDGET_USD', 'OPENAI_MONTHLY_BUDGET_USD')
  return {
    summary: 'OpenAI API costs are month-to-date.',
    metric: {
      label: 'OpenAI API cost',
      usedPercent: budget ? clampPercent(cost.value / budget * 100) : undefined,
      summary: budget
        ? `${formatCurrency(cost.value, cost.currency)} / ${formatCurrency(budget, cost.currency)} budget used`
        : `${formatCurrency(cost.value, cost.currency)} month-to-date`,
    },
  }
}

function parseCodexUsage(data: unknown): UsageMetric[] {
  const root = asRecord(data)
  const rateLimit = asRecord(root?.rate_limit)
  if (!rateLimit) return []
  const metrics: UsageMetric[] = []
  const primary = asRecord(rateLimit.primary_window)
  const secondary = asRecord(rateLimit.secondary_window)
  const planType = readString(root?.plan_type)

  if (primary) {
    const used = readNumber(primary.used_percent)
    metrics.push({
      label: planType ? `Codex session (${planType})` : 'Codex session',
      usedPercent: used !== null ? clampPercent(used) : undefined,
      resetsAt: epochSecondsToIso(primary.reset_at),
    })
  }
  if (secondary) {
    const used = readNumber(secondary.used_percent)
    metrics.push({
      label: 'Codex weekly',
      usedPercent: used !== null ? clampPercent(used) : undefined,
      resetsAt: epochSecondsToIso(secondary.reset_at),
    })
  }
  return metrics
}

function parseAntigravityUsage(data: unknown): UsageMetric[] {
  const models = extractAntigravityModels(data)
  if (!models) return []

  return ANTIGRAVITY_USAGE_MODEL_KEYS
    .map((modelKey) => {
      const value = models[modelKey]
      const info = asRecord(value)
      if (!info || info.isInternal === true || info.disabled === true) return null
      const quota = asRecord(info.quotaInfo)
      if (!quota) return null
      const remaining = readNumber(quota.remainingFraction)
      if (remaining === null || remaining < 0 || remaining > 1) return null
      const display = readString(info.displayName) ?? modelKey
      const reset = validFutureIso(readString(quota.resetTime))
      return {
        label: display,
        usedPercent: clampPercent((1 - remaining) * 100),
        summary: `${Math.round(clampPercent(remaining * 100))}% remaining`,
        resetsAt: reset ?? epochSecondsToIso(quota.resetAt),
      } satisfies UsageMetric
    })
    .filter((metric): metric is UsageMetric => metric !== null)
    .sort((a, b) => a.label.localeCompare(b.label))
}

function extractAntigravityModels(data: unknown): Record<string, unknown> | null {
  const root = asRecord(data)
  const response = asRecord(root?.response)
  const wrappedData = asRecord(root?.data)
  return asRecord(root?.models)
    ?? asRecord(response?.models)
    ?? asRecord(wrappedData?.models)
}

function parseOpenRouterCredits(data: unknown): { total: number; used: number; remaining: number } | null {
  const root = asRecord(data)
  const source = asRecord(root?.data) ?? root
  if (!source) return null
  const total = readNumber(source.total_credits)
  const used = readNumber(source.total_usage)
  if (total === null || used === null) return null
  return {
    total,
    used,
    remaining: Math.max(0, total - used),
  }
}

function parseDeepSeekBalances(data: unknown): Array<{
  currency: string
  total: number
  granted: number
  toppedUp: number
}> {
  const root = asRecord(data)
  if (!Array.isArray(root?.balance_infos)) return []
  return root.balance_infos.flatMap((item) => {
    const info = asRecord(item)
    if (!info) return []
    const currency = readString(info.currency) ?? 'USD'
    const total = readNumber(info.total_balance)
    const granted = readNumber(info.granted_balance) ?? 0
    const toppedUp = readNumber(info.topped_up_balance) ?? 0
    if (total === null) return []
    return [{ currency, total, granted, toppedUp }]
  })
}

function parseMoonshotBalance(data: unknown): {
  currency: string
  available: number
  cash: number | null
  voucher: number | null
} | null {
  const root = asRecord(data)
  const source = asRecord(root?.data) ?? root
  if (!source) return null

  const available =
    readNumber(source.available_balance)
    ?? readNumber(source.availableBalance)
    ?? readNumber(source.total_balance)
    ?? readNumber(source.totalBalance)
    ?? readNumber(source.balance)
    ?? findFirstNumberByKey(data, [
      'available_balance',
      'availableBalance',
      'total_balance',
      'totalBalance',
      'balance',
    ])
  if (available === null) return null

  const cash =
    readNumber(source.cash_balance)
    ?? readNumber(source.cashBalance)
    ?? findFirstNumberByKey(data, ['cash_balance', 'cashBalance'])
  const voucher =
    readNumber(source.voucher_balance)
    ?? readNumber(source.voucherBalance)
    ?? readNumber(source.grant_balance)
    ?? readNumber(source.grantBalance)
    ?? findFirstNumberByKey(data, [
      'voucher_balance',
      'voucherBalance',
      'grant_balance',
      'grantBalance',
    ])
  const currency = (
    readString(source.currency)
    ?? findFirstStringByKey(data, ['currency', 'unit'])
    ?? 'CNY'
  ).toUpperCase()

  return { currency, available, cash, voucher }
}

async function fetchMiniMaxUsage(apiKey: string): Promise<unknown> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const endpoints = [
    'https://www.minimax.io/v1/token_plan/remains',
    'https://www.minimax.io/v1/api/openplatform/coding_plan/remains',
  ]
  const groupId = getEnv('MINIMAX_GROUP_ID')
  if (groupId) {
    const url = new URL('https://platform.minimax.io/v1/api/openplatform/coding_plan/remains')
    url.searchParams.set('GroupId', groupId)
    endpoints.push(url.toString())
  }

  const errors: string[] = []
  for (const endpoint of endpoints) {
    try {
      return await fetchJson(endpoint, { headers })
    } catch (error) {
      errors.push(`${endpoint}: ${messageFromError(error)}`)
    }
  }
  throw new Error(errors.join('; ') || 'no MiniMax usage endpoint responded')
}

function parseMiniMaxUsage(data: unknown): {
  summary: string
  detail?: string
  metrics: UsageMetric[]
} | null {
  const rows = collectMiniMaxUsageRows(data)
  if (rows.length === 0) return null

  const metrics = rows.map(row => ({
    label: row.label,
    usedPercent: row.total > 0 ? clampPercent(row.used / row.total * 100) : undefined,
    summary: `${formatNumber(row.used)} / ${formatNumber(row.total)} used (${formatNumber(row.remaining)} remaining)`,
    resetsAt: row.resetsAt,
  }))
  const primary = rows[0]
  const plan = findFirstStringByKey(data, ['plan', 'plan_name', 'planName', 'subscription', 'subscription_name'])
  const detailParts = [
    plan ? `Plan: ${plan}.` : null,
    primary.resetsAt ? `Next reset: ${primary.resetsAt}.` : null,
    'MiniMax Token Plan usage is fetched from the official remains endpoint.',
  ].filter((part): part is string => part !== null)

  return {
    summary: `${formatNumber(primary.remaining)} of ${formatNumber(primary.total)} ${primary.unit} remaining.`,
    detail: detailParts.join(' '),
    metrics,
  }
}

function collectMiniMaxUsageRows(data: unknown): Array<{
  label: string
  used: number
  total: number
  remaining: number
  unit: string
  resetsAt?: string | null
}> {
  const rows: Array<{
    label: string
    used: number
    total: number
    remaining: number
    unit: string
    resetsAt?: string | null
  }> = []
  const seen = new Set<string>()

  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item)
      return
    }
    const record = asRecord(value)
    if (!record) return
    const row = parseMiniMaxUsageRecord(record)
    if (row) {
      const signature = `${row.label}:${row.used}:${row.total}:${row.remaining}`
      if (!seen.has(signature)) {
        seen.add(signature)
        rows.push(row)
      }
    }
    for (const item of Object.values(record)) scan(item)
  }
  scan(data)

  const root = asRecord(data)
  const source = asRecord(root?.data) ?? asRecord(root?.result) ?? root
  if (source) {
    const rootRow = parseMiniMaxUsageRecord(source)
    if (rootRow) {
      const signature = `${rootRow.label}:${rootRow.used}:${rootRow.total}:${rootRow.remaining}`
      if (!seen.has(signature)) rows.unshift(rootRow)
    }
  }

  return rows.sort((a, b) => {
    if (a.label === 'Token Plan') return -1
    if (b.label === 'Token Plan') return 1
    return a.label.localeCompare(b.label)
  })
}

function parseMiniMaxUsageRecord(record: Record<string, unknown>): {
  label: string
  used: number
  total: number
  remaining: number
  unit: string
  resetsAt?: string | null
} | null {
  const used =
    readNumber(record.used)
    ?? readNumber(record.used_count)
    ?? readNumber(record.usedCount)
    ?? readNumber(record.current_usage)
    ?? readNumber(record.currentUsage)
    ?? readNumber(record.current_interval_usage_count)
    ?? readNumber(record.currentIntervalUsageCount)
    ?? readNumber(record.used_prompts)
    ?? readNumber(record.usedPrompts)
    ?? readNumber(record.usage)
  const remaining =
    readNumber(record.remaining)
    ?? readNumber(record.remain)
    ?? readNumber(record.remains)
    ?? readNumber(record.left)
    ?? readNumber(record.available)
    ?? readNumber(record.remaining_count)
    ?? readNumber(record.remainingCount)
    ?? readNumber(record.remain_count)
    ?? readNumber(record.remainCount)
  const explicitTotal =
    readNumber(record.total)
    ?? readNumber(record.limit)
    ?? readNumber(record.quota)
    ?? readNumber(record.total_quota)
    ?? readNumber(record.totalQuota)
    ?? readNumber(record.usage_limit)
    ?? readNumber(record.usageLimit)
    ?? readNumber(record.total_count)
    ?? readNumber(record.totalCount)
    ?? readNumber(record.current_interval_quota)
    ?? readNumber(record.currentIntervalQuota)
    ?? readNumber(record.max)

  const total = explicitTotal ?? (
    used !== null && remaining !== null ? used + remaining : null
  )
  if (total === null || total <= 0) return null

  const normalizedUsed = used ?? (
    remaining !== null ? Math.max(0, total - remaining) : null
  )
  const normalizedRemaining = remaining ?? (
    normalizedUsed !== null ? Math.max(0, total - normalizedUsed) : null
  )
  if (normalizedUsed === null || normalizedRemaining === null) return null

  return {
    label: readString(record.model)
      ?? readString(record.model_id)
      ?? readString(record.modelId)
      ?? readString(record.resource)
      ?? readString(record.resource_type)
      ?? readString(record.resourceType)
      ?? readString(record.name)
      ?? 'Token Plan',
    used: normalizedUsed,
    total,
    remaining: normalizedRemaining,
    unit: readString(record.unit) ?? readString(record.quota_unit) ?? 'requests',
    resetsAt: normalizeMiniMaxReset(record),
  }
}

function normalizeMiniMaxReset(record: Record<string, unknown>): string | null {
  const raw =
    readString(record.reset_at)
    ?? readString(record.resetAt)
    ?? readString(record.reset_time)
    ?? readString(record.resetTime)
    ?? readString(record.next_reset)
    ?? readString(record.nextReset)
    ?? readString(record.expire_at)
    ?? readString(record.expireAt)
  const iso = validFutureIso(raw)
  if (iso) return iso
  return epochSecondsToIso(record.reset_at)
    ?? epochSecondsToIso(record.resetAt)
    ?? epochSecondsToIso(record.reset_time)
    ?? epochSecondsToIso(record.resetTime)
    ?? epochSecondsToIso(record.next_reset)
    ?? epochSecondsToIso(record.nextReset)
    ?? epochSecondsToIso(record.expire_at)
    ?? epochSecondsToIso(record.expireAt)
}

function copilotMetricsFromStoredPlan(blob: StoredOAuthBlob | null): UsageMetric[] {
  const meta = blob?.meta
  if (!meta) return []
  const quotas = asRecord(meta.limitedUserQuotas)
  const reset = typeof meta.limitedUserResetDate === 'number'
    ? new Date(meta.limitedUserResetDate * 1000).toISOString()
    : undefined
  if (!quotas) return []

  return Object.entries(quotas).flatMap(([key, value]) => {
    const total = readNumber(value)
    if (!total || total <= 0) return []
    return [{
      label: `Copilot ${key}`,
      summary: `${Math.round(total)} monthly quota`,
      resetsAt: reset,
    }]
  })
}

async function fetchGithubCopilotMetrics(token: string, org: string): Promise<UsageMetric> {
  const url = new URL(`https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics`)
  const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
  url.searchParams.set('since', since.toISOString().slice(0, 10))
  const data = await fetchJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  const days = Array.isArray(data) ? data : []
  return {
    label: 'Copilot org metrics',
    summary: `${days.length} daily records returned`,
    detail: 'GitHub returns activity metrics, not a percent billing meter.',
  }
}

function parseCursorSpend(data: unknown): { summary: string; metric?: UsageMetric } | null {
  const total = findFirstNumberByKey(data, [
    'totalSpend',
    'total_spend',
    'spend',
    'cost',
    'amount',
    'totalCost',
  ])
  const cents = findFirstNumberByKey(data, [
    'totalSpendCents',
    'total_spend_cents',
    'spendCents',
    'costCents',
  ])
  const dollars = total ?? (cents !== null ? cents / 100 : null)
  if (dollars === null) {
    const count = findFirstNumberByKey(data, ['totalMembers', 'numMembers', 'count'])
    if (count !== null) {
      return { summary: `Cursor returned spend data for ${Math.round(count)} records.` }
    }
    return null
  }
  const budget = getBudget('CLAUDEX_USAGE_CURSOR_BUDGET_USD', 'CURSOR_MONTHLY_BUDGET_USD')
  return {
    summary: `${formatCurrency(dollars, 'USD')} reported by Cursor Admin API.`,
    metric: {
      label: 'Cursor team spend',
      usedPercent: budget ? clampPercent(dollars / budget * 100) : undefined,
      summary: budget
        ? `${formatCurrency(dollars, 'USD')} / ${formatCurrency(budget, 'USD')} budget used`
        : `${formatCurrency(dollars, 'USD')} reported`,
    },
  }
}

async function fetchCursorSpend(adminKey: string): Promise<{ summary: string; metric?: UsageMetric } | null> {
  const auth = `Basic ${Buffer.from(`${adminKey}:`).toString('base64')}`
  let page = 1
  let totalPages = 1
  let totalMembers: number | null = null
  let totalCents = 0
  let totalFastPremiumRequests = 0
  let sawSpendRows = false
  let cycleStart: string | null = null

  while (page <= totalPages && page <= 50) {
    const data = await fetchJson('https://api.cursor.com/teams/spend', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        page,
        pageSize: 100,
      }),
    })
    const root = asRecord(data)
    const rows = Array.isArray(root?.teamMemberSpend) ? root.teamMemberSpend : []
    for (const item of rows) {
      const row = asRecord(item)
      if (!row) continue
      const spendCents = readNumber(row.spendCents)
      const requests = readNumber(row.fastPremiumRequests)
      if (spendCents !== null) {
        sawSpendRows = true
        totalCents += spendCents
      }
      if (requests !== null) totalFastPremiumRequests += requests
    }
    totalMembers = readNumber(root?.totalMembers) ?? totalMembers
    totalPages = Math.max(1, Math.floor(readNumber(root?.totalPages) ?? totalPages))
    cycleStart = epochMsToIso(root?.subscriptionCycleStart) ?? cycleStart
    page += 1
  }

  if (!sawSpendRows) return parseCursorSpend({})

  const dollars = totalCents / 100
  const budget = getBudget('CLAUDEX_USAGE_CURSOR_BUDGET_USD', 'CURSOR_MONTHLY_BUDGET_USD')
  const detailParts = [
    totalMembers !== null ? `${Math.round(totalMembers)} members` : null,
    `${formatNumber(totalFastPremiumRequests)} fast premium requests`,
    cycleStart ? `cycle started ${new Date(cycleStart).toLocaleDateString()}` : null,
  ].filter((part): part is string => part !== null)

  return {
    summary: `${formatCurrency(dollars, 'USD')} current-cycle team spend.`,
    metric: {
      label: 'Cursor team spend',
      usedPercent: budget ? clampPercent(dollars / budget * 100) : undefined,
      summary: budget
        ? `${formatCurrency(dollars, 'USD')} / ${formatCurrency(budget, 'USD')} budget used`
        : `${formatCurrency(dollars, 'USD')} reported`,
      detail: detailParts.join(', '),
      resetsAt: cycleStart,
    },
  }
}

async function fetchKiroUsage(token: string): Promise<unknown> {
  const blob = readStoredOAuth('kiro_oauth')
  const profileArn = readString(blob?.meta?.profileArn)
    ?? 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
  const params = new URLSearchParams({
    isEmailRequired: 'true',
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
  })
  const attempts: Array<() => Promise<Response>> = [
    () => fetchWithTimeout(
      `https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'x-amz-user-agent': 'aws-sdk-js/1.0.0 KiroIDE',
          'user-agent': 'aws-sdk-js/1.0.0 KiroIDE',
        },
      },
    ),
    () => fetchWithTimeout('https://codewhisperer.us-east-1.amazonaws.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        origin: 'AI_EDITOR',
        profileArn,
        resourceType: 'AGENTIC_REQUEST',
      }),
    }),
  ]

  const errors: string[] = []
  for (const attempt of attempts) {
    const response = await attempt()
    const text = await response.text()
    if (!response.ok) {
      errors.push(`${response.status}: ${truncate(text)}`)
      continue
    }
    return parseJson(text)
  }
  throw new Error(`Kiro usage failed: ${errors.join('; ')}`)
}

function parseKiroUsage(data: unknown): UsageMetric[] {
  const root = asRecord(data)
  const reset = readString(root?.nextDateReset)
    ?? readString(root?.resetDate)
    ?? epochSecondsToIso(root?.nextDateReset)
    ?? epochSecondsToIso(root?.resetDate)
  const list = Array.isArray(root?.usageBreakdownList) ? root.usageBreakdownList : []
  return list.flatMap((item) => {
    const row = asRecord(item)
    if (!row) return []
    const used = readNumber(row.currentUsageWithPrecision ?? row.currentUsage)
    const total = readNumber(row.usageLimitWithPrecision ?? row.usageLimit)
    const resource = readString(row.resourceType) ?? 'usage'
    if (used === null || total === null || total <= 0) return []
    return [{
      label: humanize(resource),
      usedPercent: clampPercent(used / total * 100),
      summary: `${formatNumber(used)} / ${formatNumber(total)} used`,
      resetsAt: reset,
    }]
  })
}

async function getAntigravityAccount(): Promise<AntigravityAccount | null> {
  const store = loadStore()
  if (store.accounts.length === 0) return null
  const active = store.accounts[store.activeIndex] ?? store.accounts.find(account => account.enabled)
  if (!active) return null
  if (active.expires > Date.now() + 5 * 60 * 1000) return active
  try {
    const refreshed = await refreshAccessToken(active.refreshToken)
    active.accessToken = refreshed.access_token
    active.expires = Date.now() + refreshed.expires_in * 1000
    saveStore(store)
    return active
  } catch {
    return active
  }
}

async function ensureAntigravityProject(accessToken: string): Promise<string | null> {
  try {
    return await ensureCodeAssistReady(accessToken, 'antigravity')
  } catch {
    return null
  }
}

async function fetchAntigravityAvailableModels(
  accessToken: string,
  projectId: string | null,
): Promise<unknown> {
  const bases = [
    CODE_ASSIST_BASE,
    'https://daily-cloudcode-pa.googleapis.com',
  ]
  const payloads = projectId ? [{ project: projectId }, {}] : [{}]
  const headers = {
    ...antigravityApiHeaders(accessToken),
    Accept: 'application/json',
    'X-Client-Name': 'antigravity',
    'X-Client-Version': ANTIGRAVITY_API_VERSION,
    'x-request-source': 'local',
  }
  let bestData: unknown = null
  const errors: string[] = []

  for (const base of bases) {
    for (const payload of payloads) {
      try {
        const data = await fetchJson(`${base}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        if (extractAntigravityModels(data)) return data
        bestData = data
      } catch (error) {
        errors.push(`${base}: ${messageFromError(error)}`)
      }
    }
  }

  if (bestData !== null) return bestData
  throw new Error(errors.join('; ') || 'no Antigravity quota response')
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchWithTimeout(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status}: ${truncate(text)}`)
  }
  return parseJson(text)
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function parseJson(text: string): unknown {
  if (!text.trim()) return {}
  return JSON.parse(text) as unknown
}

function readStoredOAuth(storageKey: string): StoredOAuthBlob | null {
  const raw = loadProviderKey(storageKey)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredOAuthBlob
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function epochSecondsToIso(value: unknown): string | null {
  const seconds = readNumber(value)
  if (seconds === null || seconds <= 0) return null
  const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000
  return new Date(ms).toISOString()
}

function validFutureIso(value: string | null): string | null {
  if (!value) return null
  const time = new Date(value).getTime()
  if (!Number.isFinite(time) || time <= Date.now()) return null
  return new Date(time).toISOString()
}

function epochMsToIso(value: unknown): string | null {
  const ms = readNumber(value)
  if (ms === null || ms <= 0) return null
  return new Date(ms).toISOString()
}

function getEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return null
}

function getBudget(...names: string[]): number | null {
  const value = getEnv(...names)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value)
}

function humanize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function monthStartIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function monthStartEpochSeconds(): number {
  return Math.floor(new Date(monthStartIso()).getTime() / 1000)
}

function nextMonthIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
}

function sumOpenAICosts(data: unknown): { value: number; currency: string } {
  let value = 0
  let currency = 'USD'
  const root = asRecord(data)
  const buckets = Array.isArray(root?.data) ? root.data : []
  for (const bucket of buckets) {
    const row = asRecord(bucket)
    const results = Array.isArray(row?.results)
      ? row.results
      : Array.isArray(row?.result)
        ? row.result
        : []
    for (const result of results) {
      const amount = asRecord(asRecord(result)?.amount)
      const amountValue = readNumber(amount?.value)
      const amountCurrency = readString(amount?.currency)
      if (amountValue !== null) value += amountValue
      if (amountCurrency) currency = amountCurrency.toUpperCase()
    }
  }
  return { value, currency }
}

function sumAnthropicCostCents(data: unknown): number {
  let cents = 0
  walk(data, (key, value) => {
    if ((key === 'amount' || key === 'cost') && typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) cents += parsed
    } else if ((key === 'amount' || key === 'cost') && typeof value === 'number') {
      cents += value
    }
  })
  return cents
}

function findFirstNumberByKey(value: unknown, keys: string[]): number | null {
  const wanted = new Set(keys)
  let found: number | null = null
  walk(value, (key, item) => {
    if (found !== null || !wanted.has(key)) return
    found = readNumber(item)
  })
  return found
}

function findFirstStringByKey(value: unknown, keys: string[]): string | null {
  const wanted = new Set(keys)
  let found: string | null = null
  walk(value, (key, item) => {
    if (found !== null || !wanted.has(key)) return
    found = readString(item)
  })
  return found
}

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  const record = asRecord(value)
  if (!record) return
  for (const [key, item] of Object.entries(record)) {
    visit(key, item)
    walk(item, visit)
  }
}

function truncate(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
