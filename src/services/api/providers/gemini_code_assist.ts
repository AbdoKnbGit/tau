/**
 * Google Gemini Code Assist client — used for OAuth-authenticated Gemini access.
 *
 * Background: the Antigravity OAuth client (used by google_oauth.ts) has
 * scopes for `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`
 * and `experimentsandconfigs`. The public AI Studio endpoint
 * (`generativelanguage.googleapis.com`) rejects tokens without the
 * `generative-language` scope ("403 restricted_client"), so OAuth calls must
 * go through the Code Assist endpoint instead.
 *
 * Code Assist endpoints:
 *   https://cloudcode-pa.googleapis.com/v1internal:{method}
 *   https://daily-cloudcode-pa.googleapis.com/v1internal:{method} for
 *   Antigravity generateContent / streamGenerateContent
 *
 * Request body is wrapped (Antigravity format from CLIProxyAPI):
 *   { model, userAgent, requestType, project, requestId, request: { sessionId, contents, ...config } }
 *
 * Response body is wrapped:
 *   { response: { candidates, usageMetadata, ... } }
 *
 * Before making calls, the user must be "onboarded" — this happens once via
 * loadCodeAssist → onboardUser, and the returned project ID is cached on disk.
 *
 * IMPORTANT: metadata.ideType MUST be "ANTIGRAVITY" (not IDE_UNSPECIFIED).
 * Bootstrap and generation also need one consistent Hub User-Agent;
 * onboardUser alone adds the node client routing header.
 *
 * Ported from router-for-me/CLIProxyAPI internal/auth/antigravity/auth.go.
 */

import { homedir } from 'os'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import type {
  GeminiGenerateContentResponse,
  GeminiStreamChunk,
} from '../adapters/gemini_to_anthropic.js'
import type { ModelInfo } from './base_provider.js'
import {
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_HUB_USER_AGENT,
} from '../../../constants/antigravity.js'
import { parseAntigravityClaudeTier } from '../../../utils/model/antigravityClaudeTiers.js'

export const CODE_ASSIST_BASE = `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal`
export const ANTIGRAVITY_GENERATION_BASE = `${ANTIGRAVITY_ENDPOINT_DAILY}/v1internal`

// ─── Executor types ──────────────────────────────────────────────────
// Two distinct executors route to the same Code Assist proxy but with
// different body envelopes, headers, and quota pools.

export type GeminiExecutor = 'cli' | 'antigravity'

export interface CodeAssistIneligibleTier {
  reasonCode?: string
  reasonMessage?: string
  validationUrl?: string
  validationLearnMoreUrl?: string
}

export interface CodeAssistLoadData {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: { id?: string; name?: string }
  paidTier?: { id?: string; name?: string }
  allowedTiers?: Array<{
    id?: string
    name?: string
    isDefault?: boolean
    userDefinedCloudaicompanionProject?: boolean
  }>
  ineligibleTiers?: CodeAssistIneligibleTier[]
}

export function codeAssistGenerationBase(executor: GeminiExecutor): string {
  return executor === 'antigravity' ? ANTIGRAVITY_GENERATION_BASE : CODE_ASSIST_BASE
}

export function codeAssistGenerationBases(executor: GeminiExecutor): readonly string[] {
  // Consumer Antigravity generation uses daily for every model and attempt.
  // Production remains the separate Code Assist/bootstrap endpoint; neither
  // it nor sandbox is a generation fallback. Retired endpoint overrides are
  // intentionally ignored so stale shell configuration cannot restore hops.
  return [codeAssistGenerationBase(executor)]
}

/**
 * Daily generation has no speculative host timeout. The provider bridge owns
 * the shared first-output deadline, including retries; restarting a healthy
 * request early can discard useful work without improving latency.
 */
export function antigravityGeminiEndpointTimeoutMs(
  _endpointIndex: number,
  _endpointCount: number,
  _onPinnedHost = false,
): number {
  return 0
}

/** HTTP recovery stays on daily and is bounded by the request retry budget. */
export function shouldTryNextAntigravityGeminiEndpoint(
  _executor: GeminiExecutor,
  _model: string,
  _status: number,
  _index: number,
  _total: number,
  _pinnedFirstAttempt = false,
): boolean {
  return false
}

// Successful-host bookkeeping is shared across main, agent and side requests.
// It can only record daily; historical pins cannot select another endpoint.
let _antigravityGeminiServedBase: string | undefined

// Preserve refusal diagnostics for callers. Cooldowns never change the
// generation host or block a new operation using stale process state.
const ANTIGRAVITY_GEMINI_HOST_COOLDOWN_MS = 60_000
const _antigravityGeminiHostCooldown = new Map<string, number>()

export function recordAntigravityGeminiHostExhausted(
  base: string,
  retryAfterMs?: number,
): void {
  const hold = Math.min(
    Math.max(retryAfterMs ?? 0, ANTIGRAVITY_GEMINI_HOST_COOLDOWN_MS),
    5 * ANTIGRAVITY_GEMINI_HOST_COOLDOWN_MS,
  )
  _antigravityGeminiHostCooldown.set(base, Date.now() + hold)
}

/** Milliseconds left on a host's recorded quota cooldown. */
export function antigravityGeminiHostCooldownMs(base: string): number {
  const until = _antigravityGeminiHostCooldown.get(base)
  if (until === undefined) return 0
  const remaining = until - Date.now()
  if (remaining <= 0) {
    _antigravityGeminiHostCooldown.delete(base)
    return 0
  }
  return remaining
}

export function _resetAntigravityGeminiHostCooldownForTest(): void {
  _antigravityGeminiHostCooldown.clear()
}

export function antigravityGeminiStickyBase(
  _sessionKey: string | undefined,
): string | undefined {
  return _antigravityGeminiServedBase
}

export function recordAntigravityGeminiServedBase(
  _sessionKey: string | undefined,
  base: string,
): void {
  if (base === ANTIGRAVITY_GENERATION_BASE) _antigravityGeminiServedBase = base
}

export function _resetAntigravityGeminiAffinityForTest(): void {
  _antigravityGeminiServedBase = undefined
}

/** Model, session and query source all share the executor's generation host. */
export function codeAssistGenerationBasesForModel(
  executor: GeminiExecutor,
  _model: string,
  _sessionKey?: string,
  _querySource?: string,
): readonly string[] {
  return codeAssistGenerationBases(executor)
}

/** All Antigravity models use the same single generation endpoint. */
export function antigravityGenerationHostCount(_model: string | undefined): number {
  return 1
}

// Antigravity-specific models — everything else is Gemini CLI.
// Includes Claude models that Antigravity re-sells through the same
// daily Antigravity endpoint. They share the `userAgent: "antigravity"`
// envelope but need small content-level fixes (see wrapForCodeAssist).
export const ANTIGRAVITY_MODELS: readonly ModelInfo[] = [
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', contextWindow: 1048576 },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', contextWindow: 1048576 },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', contextWindow: 1048576 },
  { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)', contextWindow: 1048576 },
  { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)', contextWindow: 1048576 },
  { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)', contextWindow: 1048576 },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', contextWindow: 1048576 },
  { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', contextWindow: 1048576 },
  { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', contextWindow: 1048576 },
  { id: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)', contextWindow: 1048576 },
  { id: 'gemini-3.5-flash-medium', name: 'Gemini 3.5 Flash (Medium)', contextWindow: 1048576 },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)', contextWindow: 1048576 },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', contextWindow: 1048576 },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', contextWindow: 1048576 },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1048576 },
  // One wire id per effort level, served from the daily host to paid Google
  // AI Pro/Ultra plans only (see utils/model/antigravityClaudeTiers.ts).
  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', tags: ['pro-ultra'] },
  { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5 (Medium)', tags: ['pro-ultra'] },
  { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)', tags: ['pro-ultra'] },
  { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)', tags: ['pro-ultra'] },
  { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)', tags: ['pro-ultra'] },
  { id: 'claude-sonnet-5-5-low', name: 'Claude Sonnet 5.5 (Low)', tags: ['pro-ultra'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6' },
]

const ANTIGRAVITY_WIRE_MODEL_DISPLAY_NAMES = new Map<string, string>([
  ['gemini-3.5-flash', 'Gemini 3.5 Flash'],
  ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Medium)'],
  ['gemini-3.5-flash-extra-low', 'Gemini 3.5 Flash (Low)'],
  ['gemini-3-flash-agent', 'Gemini 3.5 Flash (High)'],
  ['gemini-pro-agent', 'Gemini 3.1 Pro (High)'],
  ['gemini-3-flash-high', 'Gemini 3 Flash (High)'],
  ['gemini-3-flash-medium', 'Gemini 3 Flash (Medium)'],
  ['gemini-3-flash-low', 'Gemini 3 Flash (Low)'],
])

// Model-picker subset: `gemini-3-flash` stays fully ROUTABLE (it remains in
// ANTIGRAVITY_MODELS / ANTIGRAVITY_MODEL_IDS so saved configs and explicit
// --model flags keep working, with all cache discipline applied) but is
// hidden from model selection — its serving channel commits the implicit
// cache slowly (~40-50s vs 10-20s on 3.5-flash) and misses replicas often
// (live-measured 64-71% vs 85-93% on 3.5-flash/Claude), so offering it in
// the picker invites bad sessions for no capability gain.
export const ANTIGRAVITY_PICKER_MODELS: readonly ModelInfo[] =
  ANTIGRAVITY_MODELS.filter(model => model.id !== 'gemini-3-flash')

/**
 * The picker's Claude rows for the account's plan. Paid Google AI Pro and
 * Ultra plans get Claude 5.5; their catalog no longer lists Claude 4.6. The
 * free plan gets Claude 4.6 only, since 5.5 answers it with 404. With the plan
 * still unknown (no project discovered yet) every row stays listed.
 */
export function antigravityPickerModelsForPlan(
  tier: string | null,
): readonly ModelInfo[] {
  if (!tier) return ANTIGRAVITY_PICKER_MODELS
  const paid = isPaidGeminiTier(tier)
  return ANTIGRAVITY_PICKER_MODELS.filter(model => {
    if (parseAntigravityClaudeTier(model.id)) return paid
    if (model.id.includes('claude')) return !paid
    return true
  })
}

export const ANTIGRAVITY_MODEL_IDS = new Set([
  ...ANTIGRAVITY_MODELS.map(model => model.id),
])

/**
 * True when the id routes to the Antigravity path — Gemini models AND the
 * Claude models resold through the same proxy. Single source of truth for
 * the lazy-tools opt-out: the lane gate (lanes/gemini/lazy_tools.ts) and the
 * upstream request-filter gate (utils/toolSearch.ts) must agree, otherwise
 * claude.ts strips undiscovered deferred tools before the lane can decline.
 */
export function isAntigravityModelId(model: string): boolean {
  return ANTIGRAVITY_MODEL_IDS.has(
    model.toLowerCase().replace(/^models\//, ''),
  )
}

/**
 * Gemini-family models on the Antigravity path — everything in the
 * Antigravity set EXCEPT the Claude models resold through the same proxy.
 *
 * The implicit-cache discipline (prefix pad, commit-window pacing, agent
 * concurrency gate) targets ONLY the single-slot Gemini implicit cache.
 * Claude on Antigravity uses a multi-entry, low-minimum content-addressed
 * cache that those mechanisms would only slow down, so it is excluded.
 *
 * Callers must already know the request is on the Antigravity provider —
 * this splits Gemini from Claude, it does not distinguish Antigravity Gemini
 * from CLI Gemini.
 */
export function isAntigravityGeminiModel(model: string): boolean {
  const normalized = model.toLowerCase().replace(/^models\//, '')
  return ANTIGRAVITY_MODEL_IDS.has(normalized) && !normalized.includes('claude')
}

export function getAntigravityModelDisplayName(model: string): string | null {
  const normalized = model.toLowerCase().replace(/^models\//, '')
  return ANTIGRAVITY_MODELS.find(candidate => candidate.id === normalized)?.name
    ?? ANTIGRAVITY_WIRE_MODEL_DISPLAY_NAMES.get(normalized)
    ?? null
}

export function resolveAntigravityWireModel(model: string): string {
  const normalized = model.toLowerCase()
  // 3.6/3.7/3.8 Flash each expose ONE tiered wire model per generation; the
  // picker's Low/Medium/High rides in generationConfig.thinkingConfig
  // .thinkingLevel (see lanes/gemini/thinking.ts). Keeping all three levels
  // on a single upstream id also keeps the implicit cache warm when the user
  // switches level mid-session — the backend entry is keyed on the prompt
  // prefix under that model, so per-level ids would split it three ways.
  // The backend also serves per-level ids (`gemini-3.8-flash-high`, ...) for
  // these generations; if a tiered id is ever rejected with a 404, returning
  // `normalized` here is the whole fix.
  // Enumerated on purpose: 3.5 and older Flash use different wire keys
  // entirely (below), so a generic `gemini-3.\d+` match would break them.
  const tiered = normalized.match(/^gemini-(3\.[6-8])-flash-(?:high|medium|low)$/)
  if (tiered) {
    return `gemini-${tiered[1]}-flash-tiered`
  }
  if (normalized === 'gemini-3.1-pro-high') {
    return 'gemini-pro-agent'
  }
  if (normalized === 'gemini-3.5-flash-high') {
    return 'gemini-3-flash-agent'
  }
  if (normalized === 'gemini-3.5-flash-medium') {
    return 'gemini-3.5-flash-low'
  }
  if (normalized === 'gemini-3.5-flash-low') {
    return 'gemini-3.5-flash-extra-low'
  }
  return model
}

/** Determine which executor a model belongs to. */
export function executorForModel(model: string): GeminiExecutor {
  return ANTIGRAVITY_MODEL_IDS.has(model.toLowerCase()) ? 'antigravity' : 'cli'
}

// Antigravity onboardUser adds its node client marker to the shared Hub
// fingerprint used by loadCodeAssist and generation.
const ANTIGRAVITY_NODE_API_CLIENT = 'google-api-nodejs-client/10.3.0'
const ANTIGRAVITY_NODE_X_GOOG_API_CLIENT = 'gl-node/22.21.1'

const CONFIG_DIR = join(homedir(), '.config', 'claude-code')

// Per-executor cache files — each executor type gets its own onboarding
// and project ID because the Code Assist server tracks them separately.
const CACHE_FILE_CLI = join(CONFIG_DIR, 'gemini-code-assist-cli.json')
const CACHE_FILE_ANTIGRAVITY = join(CONFIG_DIR, 'gemini-code-assist.json')

const CACHE_VERSION = 7  // bump: retry project bootstrap after standard-tier migration

interface CodeAssistCache {
  version: number
  /** Antigravity project/entitlements belong to the credential that discovered them. */
  credentialKey?: string
  projectId: string | null
  onboardedAt: number
  /**
   * Cached `currentTier.id` from loadCodeAssist (e.g. 'free-tier',
   * 'standard-tier', 'legacy-tier'). Kept as a fallback for the picker
   * when the quota lookup is unavailable; entitled model ids below are
   * the canonical signal.
   */
  tier?: string | null
  /**
   * Concrete model ids the user has quota for, sourced from
   * retrieveUserQuota.buckets. This is gemini-cli's source of truth
   * for "does the user have access to model X" — far more reliable
   * than the tier id, since Google AI Pro consumers often keep
   * `currentTier.id = 'free-tier'` while still receiving Pro buckets.
   * Empty array means the quota lookup ran but returned nothing
   * actionable; `undefined` means the lookup hasn't run yet.
   */
  entitledModelIds?: string[]
}

// ─── Tier-id constants ──────────────────────────────────────────────
// Mirrors the subset of UserTierId values gemini-cli treats specially
// (reference/gemini-cli-main/packages/core/src/code_assist/types.ts).
// Anything outside FREE/LEGACY is treated as a paid tier.
export const GEMINI_TIER_FREE = 'free-tier'
export const GEMINI_TIER_LEGACY = 'legacy-tier'
export const GEMINI_TIER_STANDARD = 'standard-tier'

/**
 * True when the tier id represents a paid Google account that unlocks
 * Pro models. Free and legacy tiers are flash-only. An unknown/missing
 * tier is treated as free to avoid showing models the user can't call.
 */
export function isPaidGeminiTier(tier: string | null | undefined): boolean {
  if (!tier) return false
  if (tier === GEMINI_TIER_FREE) return false
  if (tier === GEMINI_TIER_LEGACY) return false
  return true
}

/**
 * Read the cached tier id for an executor (set during onboarding).
 * Returns null when no tier has been captured yet — typical for the
 * Antigravity executor, since loadCodeAssist there returns a project
 * id directly without enumerating tiers.
 */
export function getGeminiTier(executor: GeminiExecutor): string | null {
  const cache = _readCache(executor)
  return cache?.tier ?? null
}

/**
 * Read the cached list of model ids the user has quota for. Sourced
 * from retrieveUserQuota.buckets and refreshed during onboarding.
 * Returns null when no quota lookup has happened yet, or an array
 * (possibly empty) when one has. Callers should treat null/empty as
 * "no Pro entitlement detected" and fall back to the tier-based check.
 */
export function getGeminiEntitledModelIds(
  executor: GeminiExecutor,
): readonly string[] | null {
  const cache = _readCache(executor)
  if (!cache) return null
  return cache.entitledModelIds ?? null
}

/**
 * Explain a 429 that is really a missing entitlement, not exhausted quota.
 *
 * Code Assist answers a model the account is not entitled to with the same
 * `429 RESOURCE_EXHAUSTED` it uses for genuine rate limits, and the picker
 * does not filter by entitlement — so a model that has not rolled out to this
 * account is selectable and then fails with a message that reads like a quota
 * problem. The onboarding/quota lookup already caches the real list, so check
 * it before blaming quota.
 *
 * A generation may be entitled under its picker id, its `-tiered` wire id, or
 * both, so either one counts. Returns null when no entitlement lookup has run
 * yet (nothing can be claimed) or when the model is entitled.
 */
export function describeAntigravityEntitlementGap(model: string): string | null {
  const normalized = model.toLowerCase().replace(/^models\//, '')
  if (!ANTIGRAVITY_MODEL_IDS.has(normalized)) return null

  // The quota list behind `entitled` comes from production cloudcode-pa, which
  // leaves these models out even on Pro accounts (only the daily host lists
  // them), so judge them by the account's plan instead.
  const claudeTier = parseAntigravityClaudeTier(normalized)
  if (claudeTier) {
    const plan = getGeminiTier('antigravity')
    if (!plan || isPaidGeminiTier(plan)) return null
    return [
      `${claudeTier.model.name} on Antigravity is for paid Google AI Pro and Ultra plans, and this account is on ${plan === GEMINI_TIER_FREE ? 'the free plan' : `the "${plan}" plan`}.`,
      'Antigravity answers a model the plan does not include with 404 or 429, which reads like a missing model or spent quota.',
    ].join('\n')
  }

  const entitled = getGeminiEntitledModelIds('antigravity')
  if (!entitled || entitled.length === 0) return null

  const entitledSet = new Set(entitled.map(id => id.toLowerCase()))
  const wireModel = resolveAntigravityWireModel(normalized).toLowerCase()
  if (entitledSet.has(normalized) || entitledSet.has(wireModel)) return null

  const alternatives = ANTIGRAVITY_MODELS
    .map(candidate => candidate.id)
    .filter(id =>
      entitledSet.has(id) || entitledSet.has(resolveAntigravityWireModel(id).toLowerCase()))

  return [
    `This Antigravity account is not entitled to ${normalized}.`,
    'Code Assist reports an unentitled model as HTTP 429 RESOURCE_EXHAUSTED, which looks',
    'identical to running out of quota, and the model picker does not filter by entitlement.',
    ...(alternatives.length > 0
      ? ['', `Models this account can use: ${alternatives.join(', ')}`]
      : []),
  ].join('\n')
}

/**
 * True when the entitled-models list contains any Pro-tier model id —
 * that is, anything that isn't a flash variant. Mirrors the heuristic
 * gemini-cli uses to set `hasAccessToPreviewModel` from quota buckets
 * (`config.ts:2235-2239` walks buckets looking for a preview model).
 */
export function hasPaidEntitlement(
  modelIds: readonly string[] | null,
): boolean {
  if (!modelIds || modelIds.length === 0) return false
  return modelIds.some(id => {
    const lower = id.toLowerCase()
    if (lower.includes('flash')) return false
    if (lower.includes('embedding')) return false
    return lower.includes('pro') || lower.includes('preview')
  })
}

// In-memory caches — one per executor type
let _cachedCli: CodeAssistCache | null = null
let _cachedAntigravity: CodeAssistCache | null = null
let _antigravityCredentialKey: string | undefined
let _antigravityCacheEpoch = 0
const _antigravityBootstrap = new Map<string, Promise<string | null>>()

function antigravityCredentialKey(accessToken: string): string {
  // Persist a one-way fingerprint, never the bearer token. A refreshed token
  // revalidates project ownership once; ordinary turns keep the warm cache.
  return createHash('sha256').update(accessToken).digest('hex')
}

/**
 * Clear the cached project ID for an executor. Called when we get a 403
 * "does not have permission" error — the cached project is stale and the
 * next call will re-onboard to get a fresh project ID.
 */
export function clearCodeAssistCache(executor?: GeminiExecutor): void {
  if (!executor || executor === 'cli') {
    _cachedCli = null
    try { const f = _cacheFileFor('cli'); if (existsSync(f)) writeFileSync(f, '{}') } catch {}
  }
  if (!executor || executor === 'antigravity') {
    _cachedAntigravity = null
    _antigravityCredentialKey = undefined
    _antigravityCacheEpoch++
    _antigravityBootstrap.clear()
    try { const f = _cacheFileFor('antigravity'); if (existsSync(f)) writeFileSync(f, '{}') } catch {}
  }
}

function _cacheFileFor(executor: GeminiExecutor): string {
  return executor === 'cli' ? CACHE_FILE_CLI : CACHE_FILE_ANTIGRAVITY
}

function _readCache(executor: GeminiExecutor, credentialKey?: string): CodeAssistCache | null {
  const owner = credentialKey ?? _antigravityCredentialKey
  const matches = (cache: CodeAssistCache): boolean => executor === 'cli'
    || (!!owner && cache.credentialKey === owner)
  const mem = executor === 'cli' ? _cachedCli : _cachedAntigravity
  if (mem && matches(mem)) return mem
  try {
    const file = _cacheFileFor(executor)
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as CodeAssistCache
    if ((parsed.version ?? 0) < CACHE_VERSION) return null
    if (!matches(parsed)) return null
    if (executor === 'cli') _cachedCli = parsed
    else _cachedAntigravity = parsed
    return parsed
  } catch {
    return null
  }
}

function _writeCache(executor: GeminiExecutor, cache: CodeAssistCache): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(_cacheFileFor(executor), JSON.stringify(cache, null, 2))
    if (executor === 'cli') _cachedCli = cache
    else _cachedAntigravity = cache
  } catch {
    // Cache is best-effort.
  }
}

/** Native headers for Antigravity loadCodeAssist. */
export function antigravityLoadCodeAssistHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_HUB_USER_AGENT,
  }
}

/** Native control-plane headers for Antigravity onboardUser. */
export function antigravityOnboardUserHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `${ANTIGRAVITY_HUB_USER_AGENT} ${ANTIGRAVITY_NODE_API_CLIENT}`,
    'X-Goog-Api-Client': ANTIGRAVITY_NODE_X_GOOG_API_CLIENT,
  }
}

export function antigravityOnboardUserBody(tierId: string): {
  tier_id: string
  metadata: { ide_type: string; ide_version: string; ide_name: string }
} {
  return {
    tier_id: tierId,
    metadata: {
      ide_type: 'ANTIGRAVITY',
      ide_version: ANTIGRAVITY_API_VERSION,
      ide_name: 'antigravity',
    },
  }
}

/** Onboarding headers for the Gemini CLI executor. */
function _cliOnboardHeaders(accessToken: string): Record<string, string> {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `GeminiCLI/0.31.0 (${os}; ${arch})`,
    'X-Goog-Api-Client': 'google-genai-sdk/1.41.0 gl-node/v22.19.0',
    'Connection': 'keep-alive',
  }
}

// ─── Onboarding ──────────────────────────────────────────────────────

/**
 * Fetch with retry on transient failures (5xx / network). Used for
 * onboarding calls where the first-request latency matters — without
 * this, a single 503 from Code Assist forces the user to retry their
 * prompt manually. Up to 3 attempts with 500/1500/3000 ms backoff.
 *
 * 4xx responses are NOT retried — those are terminal (bad token,
 * unauthorized, etc.) and callers surface them as-is.
 */
async function _fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  opts: { maxAttempts?: number } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      // 4xx → surface immediately; retrying won't help.
      if (res.status >= 400 && res.status < 500) return res
      // 5xx → retry with backoff unless we're out of attempts.
      if (attempt >= maxAttempts) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
      if (attempt >= maxAttempts) throw e
    }
    await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt - 1)))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function _loadCodeAssist(
  accessToken: string,
  executor: GeminiExecutor,
): Promise<CodeAssistLoadData> {
  const isAntigravity = executor === 'antigravity'
  const headers = isAntigravity
    ? antigravityLoadCodeAssistHeaders(accessToken)
    : _cliOnboardHeaders(accessToken)
  const body = isAntigravity
    ? { metadata: { ideType: 'ANTIGRAVITY' } }
    : {
      metadata: {
        ideType: 'GEMINI_CLI',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }

  const response = await _fetchWithTransientRetry(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    const eligibilityError = codeAssistEligibilityErrorMessage(
      executor,
      undefined,
      errorText,
    )
    if (eligibilityError) throw new Error(eligibilityError)
    throw new Error(
      `Gemini Code Assist loadCodeAssist failed (${response.status}): ${errorText.slice(0, 300)}`,
    )
  }

  try {
    return (await response.json()) as CodeAssistLoadData
  } catch (error) {
    throw new Error(
      `Gemini Code Assist loadCodeAssist returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

async function _rediscoverAntigravityProject(accessToken: string): Promise<string | null> {
  const maxAttempts = 6
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, attempt * 500))
    }
    const refreshed = await _loadCodeAssist(accessToken, 'antigravity')
    const projectId = _extractProjectId(refreshed.cloudaicompanionProject)
    if (projectId) return projectId
  }
  return null
}

/**
 * Ensure the user is onboarded to Code Assist and return the project ID.
 *
 * Each executor type (CLI vs Antigravity) has its own cache and uses
 * different onboarding headers/metadata so the server associates the
 * project with the right quota pool.
 */
/**
 * The already-discovered Code Assist project, or null if discovery has not
 * run yet. Pure read - no network, no onboarding, no cache write.
 *
 * ensureCodeAssistReady below will discover and persist one, which is right
 * for a request that must succeed and wrong for a status readout. Callers that
 * only want to scope a read should wait for a project rather than create one.
 */
export function peekCodeAssistProject(
  executor: GeminiExecutor = 'antigravity',
  accessToken?: string,
): string | null {
  return _readCache(executor, accessToken ? antigravityCredentialKey(accessToken) : undefined)?.projectId ?? null
}

export async function ensureCodeAssistReady(
  accessToken: string,
  executor: GeminiExecutor = 'antigravity',
): Promise<string | null> {
  if (executor === 'cli') return _ensureCodeAssistReady(accessToken, executor)

  const credentialKey = antigravityCredentialKey(accessToken)
  _antigravityCredentialKey = credentialKey
  const cached = _readCache(executor, credentialKey)
  if (cached?.projectId) return cached.projectId
  const pending = _antigravityBootstrap.get(credentialKey)
  if (pending) return pending

  const bootstrap = _ensureCodeAssistReady(accessToken, executor, credentialKey)
  _antigravityBootstrap.set(credentialKey, bootstrap)
  try {
    return await bootstrap
  } finally {
    if (_antigravityBootstrap.get(credentialKey) === bootstrap) {
      _antigravityBootstrap.delete(credentialKey)
    }
  }
}

async function _ensureCodeAssistReady(
  accessToken: string,
  executor: GeminiExecutor,
  credentialKey?: string,
): Promise<string | null> {
  const cached = _readCache(executor, credentialKey)
  if (cached?.projectId) return cached.projectId
  const epoch = _antigravityCacheEpoch
  const cacheProject = (cache: CodeAssistCache): void => {
    if (executor === 'antigravity') {
      // A cleared cache or a newer login must not be overwritten by an older
      // warmup finishing in the background. Its caller can still use its own
      // discovered project, paired with the token that started that request.
      if (epoch !== _antigravityCacheEpoch || credentialKey !== _antigravityCredentialKey) return
      cache.credentialKey = credentialKey
    }
    _writeCache(executor, cache)
  }

  const loadData = await _loadCodeAssist(accessToken, executor)

  // Capture the user's effective tier so the model picker can decide
  // whether to surface Pro models. Use `paidTier.id` first (set when
  // the user actually has a paid subscription — Google AI Pro / Ultra)
  // then `currentTier.id` (active tier). This mirrors gemini-cli's
  // setup.ts: `loadRes.paidTier?.id ?? loadRes.currentTier.id`.
  //
  // Do NOT consult `allowedTiers` here — those are tiers the user
  // *could* be on, not the one they actually use. A free-tier account
  // typically has `allowedTiers = [free, standard]` because they are
  // *eligible* to upgrade, and treating that as "they're already paid"
  // makes the picker show Pro models to free users (the bug we're fixing).
  // Consumer Google AI Pro users without a `paidTier` field are caught
  // by the entitled-id bucket check downstream, not by this tier.
  const observedTier = _pickTier(
    _normalizeTier(loadData.paidTier?.id),
    _normalizeTier(loadData.currentTier?.id),
  )

  // Workaround for Google's "ghost project" bug
  // (github.com/google-gemini/gemini-cli/issues/24747, /25189): the
  // backend sometimes returns a `cloudaicompanionProject` that the
  // user's account doesn't actually have permission on, producing a
  // 403 PERMISSION_DENIED on every subsequent call. Honor an explicit
  // `GOOGLE_CLOUD_PROJECT` (or `GEMINI_CLOUD_PROJECT`) env var to
  // override the auto-discovered project. This matches the env var
  // gemini-cli, gcloud, and the Google AI SDKs already check.
  // Cloud project overrides are for Gemini CLI. Antigravity uses the managed
  // project assigned to its OAuth account, including when both are configured.
  const projectOverride = executor === 'cli' ? _projectOverrideFromEnv() : null
  if (projectOverride) {
    const entitled = await _fetchEntitledModelIds(
      accessToken,
      projectOverride,
      executor,
    )
    cacheProject({
      version: CACHE_VERSION,
      projectId: projectOverride,
      onboardedAt: Date.now(),
      tier: observedTier,
      entitledModelIds: entitled,
    })
    return projectOverride
  }

  const directProjectId = _extractProjectId(loadData.cloudaicompanionProject)
  if (directProjectId) {
    // Resolve quota in parallel with returning the project id. The quota
    // call is best-effort — Code Assist returns 403 on some scoped
    // tokens, and we don't want listModels() to fail just because the
    // entitlement lookup did. tier alone is then the fallback signal.
    const entitled = await _fetchEntitledModelIds(
      accessToken,
      directProjectId,
      executor,
    )
    cacheProject({
      version: CACHE_VERSION,
      projectId: directProjectId,
      onboardedAt: Date.now(),
      tier: observedTier,
      entitledModelIds: entitled,
    })
    return directProjectId
  }

  // `ineligibleTiers` can coexist with usable tiers (for example, a free
  // account may be ineligible for a paid tier). Treat it as fatal only when
  // loadCodeAssist did not advertise any tier the account can actually use.
  const hasEligibleTier = codeAssistHasEligibleTier(loadData)
  if (!hasEligibleTier) {
    const eligibilityError = codeAssistEligibilityErrorMessage(
      executor,
      loadData.ineligibleTiers,
    )
    if (eligibilityError) throw new Error(eligibilityError)
  }

  const onboarding = codeAssistOnboardingDecision(loadData, executor)
  if (onboarding.kind === 'require-user-project') {
    throw new Error(_userDefinedProjectMessage(onboarding.tierId))
  }
  const tierId = onboarding.tierId

  // Antigravity standard-tier onboarding commonly returns `{done:true}` with
  // no project in that response. That means the bootstrap was accepted; the
  // assigned project is exposed by a subsequent loadCodeAssist call. Current
  // Antigravity proxies use this load → onboard → load sequence.
  const immediateProject = await _onboardUser(accessToken, tierId, executor)
  const onboardedProject = immediateProject ?? (
    executor === 'antigravity'
      ? await _rediscoverAntigravityProject(accessToken)
      : null
  )
  if (!onboardedProject) {
    throw new Error(
      executor === 'antigravity'
        ? `Antigravity accepted onboarding for tier "${tierId}" but did not expose the assigned project after retrying loadCodeAssist. ` +
            'Tau did not cache an empty project; retry the request once to resume project discovery.'
        : 'Gemini Code Assist onboarding completed without a project id.',
    )
  }
  const entitled = await _fetchEntitledModelIds(
    accessToken,
    onboardedProject,
    executor,
  )
  cacheProject({
    version: CACHE_VERSION,
    projectId: onboardedProject,
    onboardedAt: Date.now(),
    tier: observedTier ?? _normalizeTier(tierId),
    entitledModelIds: entitled,
  })
  return onboardedProject
}

/**
 * Call retrieveUserQuota on the Code Assist v1internal endpoint and
 * return the list of model ids the user has buckets for.
 *
 * gemini-cli's `config.ts:2196-2240` makes the same call and uses the
 * returned `buckets[].modelId` array as the source of truth for "does
 * the user have access to model X". Buckets that lack a `modelId` (rare
 * — global quota) are skipped.
 *
 * Best-effort: returns undefined on 403, network error, or a malformed
 * payload. The caller falls back to the tier-id signal in that case.
 */
async function _fetchEntitledModelIds(
  accessToken: string,
  projectId: string,
  executor: GeminiExecutor,
): Promise<string[] | undefined> {
  const buckets = await _fetchQuotaBuckets(accessToken, projectId, executor)
  if (!buckets) return undefined
  const ids = buckets
    .map(b => (typeof b.modelId === 'string' ? b.modelId.trim() : ''))
    .filter(id => id.length > 0)
  // Dedupe while preserving order — buckets occasionally repeat the
  // same model under different reset windows.
  return Array.from(new Set(ids))
}

/**
 * One bucket entry from `retrieveUserQuota`. Mirrors the proto shape
 * gemini-cli reads in `RetrieveUserQuotaResponse.buckets[]`. Surfaced
 * publicly so the `/usage` reporter can render per-tier progress bars
 * without re-implementing the wire call.
 */
export interface GeminiQuotaBucket {
  modelId?: string
  /** Remaining count (string-encoded int64 in the proto). */
  remainingAmount?: string
  /** 0..1 — what gemini-cli plots as "% remaining". */
  remainingFraction?: number
  /** ISO-8601 timestamp for the next quota reset. */
  resetTime?: string
  /** "credit", "throttled", etc. — passed through unmodified. */
  tokenType?: string
}

async function _fetchQuotaBuckets(
  accessToken: string,
  projectId: string,
  executor: GeminiExecutor,
): Promise<GeminiQuotaBucket[] | undefined> {
  const headers = executor === 'cli'
    ? _cliOnboardHeaders(accessToken)
    : antigravityLoadCodeAssistHeaders(accessToken)

  try {
    const res = await _fetchWithTransientRetry(
      `${CODE_ASSIST_BASE}:retrieveUserQuota`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ project: projectId }),
      },
      { maxAttempts: 2 },
    )

    if (!res.ok) return undefined

    const data = (await res.json()) as { buckets?: GeminiQuotaBucket[] }
    return data.buckets ?? []
  } catch {
    return undefined
  }
}

/**
 * Public quota fetch for the `/usage` Gemini reporter. Returns the raw
 * `retrieveUserQuota.buckets[]` for the CLI executor — `modelId`,
 * `remainingFraction`, `resetTime` are the fields the bar chart needs.
 *
 * Returns `undefined` when the call fails (403/network/malformed).
 * Callers must have onboarded the user first; pass the projectId from
 * `ensureCodeAssistReady('cli')`.
 */
export async function fetchGeminiCliQuotaBuckets(
  accessToken: string,
  projectId: string,
): Promise<GeminiQuotaBucket[] | undefined> {
  return _fetchQuotaBuckets(accessToken, projectId, 'cli')
}

export type CodeAssistOnboardingDecision =
  | { kind: 'onboard'; tierId: string }
  | { kind: 'require-user-project'; tierId: string }

export function codeAssistHasEligibleTier(loadData: CodeAssistLoadData): boolean {
  return !!(
    _normalizeTier(loadData.paidTier?.id) ||
    _normalizeTier(loadData.currentTier?.id) ||
    loadData.allowedTiers?.some(tier => !!_normalizeTier(tier.id))
  )
}

/**
 * Tier accepted by Antigravity's onboardUser endpoint. The default allowed
 * tier is the control-plane input; paidTier describes quota and is not a
 * reliable onboardUser tier id.
 */
export function codeAssistAntigravityOnboardTierId(
  loadData: CodeAssistLoadData,
): string {
  const allowedTier = loadData.allowedTiers?.find(tier => tier.isDefault)
    ?? loadData.allowedTiers?.[0]
  return _normalizeTier(allowedTier?.id)
    ?? _normalizeTier(loadData.currentTier?.id)
    ?? GEMINI_TIER_FREE
}

export function codeAssistOnboardingDecision(
  loadData: CodeAssistLoadData,
  executor: GeminiExecutor = 'cli',
): CodeAssistOnboardingDecision {
  if (executor === 'antigravity') {
    return {
      kind: 'onboard',
      tierId: codeAssistAntigravityOnboardTierId(loadData),
    }
  }

  const currentTierId = _normalizeTier(loadData.paidTier?.id)
    ?? _normalizeTier(loadData.currentTier?.id)
  if (currentTierId) {
    return { kind: 'require-user-project', tierId: currentTierId }
  }

  const tier = loadData.allowedTiers?.find(candidate => candidate.isDefault)
    ?? loadData.allowedTiers?.[0]
  const tierId = _normalizeTier(tier?.id) ?? GEMINI_TIER_LEGACY
  if (tierId !== GEMINI_TIER_FREE || tier?.userDefinedCloudaicompanionProject === true) {
    return { kind: 'require-user-project', tierId }
  }
  return { kind: 'onboard', tierId }
}

export function codeAssistEligibilityErrorMessage(
  executor: GeminiExecutor,
  tiers?: CodeAssistIneligibleTier[],
  rawResponse = '',
): string | null {
  const tierDetails = (tiers ?? []).flatMap(tier => [
    tier.reasonCode?.trim() ?? '',
    tier.reasonMessage?.trim() ?? '',
  ])
  const combined = [rawResponse, ...tierDetails].filter(Boolean).join(' ')

  if (/UNSUPPORTED_CLIENT/i.test(combined)) {
    return executor === 'antigravity'
      ? 'Google rejected this account for Antigravity (UNSUPPORTED_CLIENT). ' +
          'Confirm an active Antigravity plan at https://antigravity.google/ and run `/login antigravity` again.'
      : 'Gemini Code Assist consumer OAuth is no longer supported. ' +
          'Migrate the account to Antigravity at https://antigravity.google/.'
  }

  if (!tiers?.length) return null

  const reasons = tiers
    .map(tier => tier.reasonMessage?.trim() || tier.reasonCode?.trim())
    .filter((reason): reason is string => !!reason)
  const validationUrls = tiers.flatMap(tier => [
    tier.validationUrl?.trim(),
    tier.validationLearnMoreUrl?.trim(),
  ]).filter((url): url is string => !!url)

  const detail = reasons.length > 0 ? reasons.join('; ') : 'the account is not eligible'
  const validation = validationUrls.length > 0
    ? ` Complete account validation: ${validationUrls.join(' ')}`
    : ''
  const product = executor === 'antigravity' ? 'Antigravity' : 'Gemini Code Assist'
  return `${product} access is unavailable: ${detail}.${validation}`
}

function _userDefinedProjectMessage(tierId: string): string {
  return `Gemini Code Assist did not return a managed project for tier "${tierId}". ` +
    'Set GOOGLE_CLOUD_PROJECT (or GEMINI_CLOUD_PROJECT) to a Google Cloud project ' +
    'where Gemini for Google Cloud is enabled, then retry. Tau skipped legacy ' +
    'onboardUser provisioning because this tier requires a user-defined project.'
}

function _normalizeTier(tier: string | null | undefined): string | null {
  if (!tier) return null
  const trimmed = tier.trim()
  return trimmed ? trimmed : null
}

/**
 * Pick the most "paid" tier id from a list of candidates. Order: any
 * non-null, non-free, non-legacy id wins; otherwise return the first
 * non-null id; otherwise null. This is what lets a Google AI Pro user
 * with `currentTier=free-tier` but `allowedTiers=[free, standard]`
 * resolve to `standard-tier` instead of `free-tier`.
 */
function _pickTier(...candidates: Array<string | null>): string | null {
  for (const c of candidates) {
    if (c && c !== GEMINI_TIER_FREE && c !== GEMINI_TIER_LEGACY) return c
  }
  for (const c of candidates) {
    if (c) return c
  }
  return null
}

/**
 * Read an explicit Cloud project override from the environment. We
 * accept `GOOGLE_CLOUD_PROJECT` (the gcloud / Vertex / GenAI standard)
 * and `GEMINI_CLOUD_PROJECT` (claudex-specific). Returns null when
 * neither is set or both are blank. This is the documented client-side
 * mitigation for the "ghost project" 403 bug — see
 * github.com/google-gemini/gemini-cli/issues/24747.
 */
function _projectOverrideFromEnv(): string | null {
  const candidates = [
    process.env.GEMINI_CLOUD_PROJECT,
    process.env.GOOGLE_CLOUD_PROJECT,
  ]
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

/**
 * Extract a project id out of the polymorphic shapes the Code Assist
 * API returns:
 *   - `"project-123"`                 (plain string)
 *   - `{ id: "project-123" }`         (wrapper object)
 *   - anything else / missing → null.
 */
function _extractProjectId(
  value: string | { id?: string } | undefined,
): string | null {
  if (!value) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'object' && typeof value.id === 'string') {
    const trimmed = value.id.trim()
    return trimmed ? trimmed : null
  }
  return null
}

/**
 * Run Code Assist onboardUser. A completed Antigravity operation may omit
 * the project id; callers must then rediscover it with loadCodeAssist.
 */
async function _onboardUser(
  accessToken: string,
  tierId: string,
  executor: GeminiExecutor = 'antigravity',
): Promise<string | null> {
  const ideType = executor === 'cli' ? 'GEMINI_CLI' : 'ANTIGRAVITY'
  const headers = executor === 'cli'
    ? _cliOnboardHeaders(accessToken)
    : antigravityOnboardUserHeaders(accessToken)
  const requestBody = executor === 'antigravity'
    ? antigravityOnboardUserBody(tierId)
    : {
      tierId,
      metadata: {
        ideType,
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }
  const bodyJson = JSON.stringify(requestBody)

  const maxAttempts = 5
  let lastErr: string | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const perRequestTimeout = setTimeout(() => controller.abort(), 30_000)

    let res: Response
    try {
      res = await _fetchWithTransientRetry(`${CODE_ASSIST_BASE}:onboardUser`, {
        method: 'POST',
        headers,
        body: bodyJson,
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(perRequestTimeout)
      lastErr = e instanceof Error ? e.message : String(e)
      throw new Error(
        `Gemini Code Assist onboardUser request failed: ${lastErr}`,
      )
    }
    clearTimeout(perRequestTimeout)

    const text = await res.text().catch(() => '')

    if (!res.ok) {
      const preview = text.trim().slice(0, 200)
      throw new Error(
        `Gemini Code Assist onboardUser failed (${res.status}): ${preview}`,
      )
    }

    let data: {
      done?: boolean
      response?: {
        cloudaicompanionProject?: string | { id?: string }
      }
    } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch (e) {
      throw new Error(
        `Gemini Code Assist onboardUser returned non-JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    if (data.done === true) {
      const projectId = _extractProjectId(data.response?.cloudaicompanionProject)
      return projectId
    }

    // Not done yet — wait and retry. Use 1.5s instead of CLIProxyAPI's 2s
    // cadence to reduce first-request latency.
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  throw new Error(
    'Gemini Code Assist onboardUser did not complete after 5 attempts. ' +
      'This usually means the Google account is missing Antigravity access — ' +
      'check the account at https://antigravity.google.com and try again.',
  )
}

// ─── Request wrapping ────────────────────────────────────────────────

export interface CodeAssistWrapperBody {
  model: string
  userAgent: string
  requestType: string
  project: string
  requestId: string
  request: Record<string, unknown>
}

/**
 * Wrap a standard Gemini generateContent request body in the Code Assist
 * envelope shape.
 *
 * Matches CLIProxyAPI's geminiToAntigravity() format:
 *   - userAgent "antigravity" — tells the server which client so quota is
 *     routed to the Antigravity pool rather than the free Code Assist tier
 *   - requestType "agent" — classifies the request
 *   - requestId "agent-<uuid>" — per-request identifier
 *   - request.sessionId — stable hash for dedup (derived from first user msg)
 *   - request.safetySettings deleted (Antigravity executor strips these)
 *
 * `identity` replaces the per-request id and adds `request.labels` for the
 * trajectory envelope (lanes/gemini/antigravity_trajectory.ts); the prompt
 * and generation fields are the same either way.
 */
export function wrapForCodeAssist(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
  sessionId?: string,
  identity?: { requestId: string; labels: Record<string, string> },
): CodeAssistWrapperBody {
  // Strip safetySettings — the Antigravity executor always removes them.
  // Also strip maxOutputTokens for non-Claude models (Antigravity executor
  // deletes request.generationConfig.maxOutputTokens for Gemini models).
  const wireModel = resolveAntigravityWireModel(model)
  const request = { ...innerRequest }
  delete request.safetySettings
  const isClaude = wireModel.includes('claude')
  if (!isClaude) {
    const gc = request.generationConfig as Record<string, unknown> | undefined
    if (gc) {
      const wireConfig = { ...gc }
      delete wireConfig.maxOutputTokens
      request.generationConfig = wireConfig
    }
  }

  // Claude-on-Antigravity content massaging (from CLIProxyAPI's antigravity
  // transformRequest): functionResponse parts force role "user" (Claude's
  // tool-result convention), and thought-only / thoughtSignature-only parts
  // that don't carry a functionCall or text are dropped — Claude rejects
  // them as empty parts otherwise.
  if (isClaude) {
    // Content normalization replaces array entries; never mutate the caller's
    // history, which may be reused by retries or subsequent conversation turns.
    if (Array.isArray(request.contents)) request.contents = [...request.contents]
    _applyClaudeContentFixes(request)
  }

  // Generate a stable session ID for Antigravity dedup. Legacy provider calls
  // pass it separately because the standard Gemini request shape must not gain
  // an unknown field on direct API-key requests. Native lanes carry it in the
  // internal body. Only fall back to the first-user-message hash when neither
  // transport supplied an affinity id.
  const explicitSessionId = sessionId?.trim() || null
  const bodySessionId = typeof request.sessionId === 'string' && request.sessionId.length > 0
    ? request.sessionId
    : null
  const providedSessionId = explicitSessionId ?? bodySessionId
  request.sessionId = providedSessionId ?? _stableSessionId(request)
  if (identity) request.labels = { ...identity.labels }

  return {
    model: wireModel,
    userAgent: 'antigravity',
    requestType: wireModel.includes('image') ? 'image_gen' : 'agent',
    project: projectId ?? _randomProjectId(),
    requestId: identity?.requestId ?? (wireModel.includes('image')
      ? `image_gen/${Date.now()}/${randomUUID()}/12`
      : `agent-${randomUUID()}`),
    request,
  }
}

/**
 * Wrap a standard Gemini generateContent request in the Gemini CLI envelope.
 *
 * Simpler than the Antigravity format — just `{model, project, request}`.
 * safetySettings and maxOutputTokens are kept (the CLI executor does not strip them).
 *
 * From CLIProxyAPI internal/translator/gemini-cli/gemini/gemini-cli_gemini_request.go:
 *   template := `{"project":"","request":{},"model":""}`
 */
export function wrapForGeminiCLI(
  model: string,
  projectId: string | null,
  innerRequest: Record<string, unknown>,
): { model: string; project: string; request: Record<string, unknown> } {
  return {
    model,
    project: projectId ?? _randomProjectId(),
    request: { ...innerRequest },
  }
}

// ─── Per-executor API call headers ──────────────────────────────────
// These are the headers sent on generateContent / streamGenerateContent
// calls — NOT the onboarding headers (loadCodeAssist / onboardUser).
// Quota routing depends on these matching the expected client identity.

/**
 * Headers for Gemini CLI executor API calls.
 * Matches CLIProxyAPI's applyGeminiCLIHeaders():
 *   User-Agent: GeminiCLI/0.31.0/<model> (<os>; <arch>)
 *   X-Goog-Api-Client: google-genai-sdk/1.41.0 gl-node/v22.19.0
 */
export function geminiCLIApiHeaders(accessToken: string, model: string): Record<string, string> {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'x86'
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `GeminiCLI/0.31.0/${model} (${os}; ${arch})`,
    'X-Goog-Api-Client': 'google-genai-sdk/1.41.0 gl-node/v22.19.0',
  }
}

/**
 * Headers for Antigravity executor API calls.
 * Keep these minimal and identical across operating systems; the request body
 * carries the Antigravity routing metadata. X-Goog-Api-Client is only used by
 * onboardUser above.
 */
export function antigravityApiHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': ANTIGRAVITY_HUB_USER_AGENT,
  }
}

/**
 * Apply Claude-on-Antigravity content fixes in place.
 *
 * Antigravity re-sells Claude 4.6 through the same Code Assist proxy, but
 * the bridge on Google's side treats Claude's content list slightly
 * differently from Gemini's:
 *
 *   1. Any content whose parts contain a `functionResponse` must have
 *      role="user" (Claude's tool-result messages are user-role).
 *   2. Parts that are pure `{thought: true}` with no functionCall are
 *      dropped — Claude rejects empty thought blobs (Gemini 3.x sends
 *      these, Claude doesn't accept them).
 *   3. Parts that carry only a `thoughtSignature` with no functionCall
 *      and no text are dropped for the same reason.
 *
 * Mirrors CLIProxyAPI's antigravity executor transformRequest().
 */
function _applyClaudeContentFixes(request: Record<string, unknown>): void {
  const contents = request.contents
  if (!Array.isArray(contents)) return
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i] as { role?: string; parts?: Array<Record<string, unknown>> } | null
    if (!c || !Array.isArray(c.parts)) continue
    const hasFunctionResponse = c.parts.some(p => p && typeof p === 'object' && 'functionResponse' in p)
    const role = hasFunctionResponse ? 'user' : c.role
    const parts = c.parts.filter(p => {
      if (!p || typeof p !== 'object') return true
      const hasFunctionCall = 'functionCall' in p
      const hasText = 'text' in p && typeof (p as { text?: unknown }).text === 'string'
      if ('thought' in p && !hasFunctionCall) return false
      if ('thoughtSignature' in p && !hasFunctionCall && !hasText) return false
      return true
    })
    contents[i] = { ...c, role, parts }
  }
}

/** Deterministic session ID from the first user message, for dedup. */
function _stableSessionId(request: Record<string, unknown>): string {
  const contents = request.contents as Array<{ role?: string; parts?: Array<{ text?: string }> }> | undefined
  if (Array.isArray(contents)) {
    for (const c of contents) {
      if (c.role === 'user' && c.parts?.[0]?.text) {
        // Simple hash — doesn't need to be cryptographic, just stable.
        let h = 0
        for (const ch of c.parts[0].text) {
          h = ((h << 5) - h + ch.charCodeAt(0)) | 0
        }
        return '-' + Math.abs(h).toString()
      }
    }
  }
  return '-' + Math.floor(Math.random() * 9e18).toString()
}

/** Random project ID fallback matching CLIProxyAPI's generateProjectID(). */
function _randomProjectId(): string {
  const adj = ['useful', 'bright', 'swift', 'calm', 'bold']
  const noun = ['fuze', 'wave', 'spark', 'flow', 'core']
  const a = adj[Math.floor(Math.random() * adj.length)]
  const n = noun[Math.floor(Math.random() * noun.length)]
  const r = randomUUID().slice(0, 5).toLowerCase()
  return `${a}-${n}-${r}`
}

/**
 * Unwrap a single Code Assist non-streaming response into standard Gemini shape.
 */
export function unwrapCodeAssistResponse(
  caResponse: unknown,
): GeminiGenerateContentResponse {
  if (!caResponse || typeof caResponse !== 'object') return {}
  const wrapped = caResponse as { response?: GeminiGenerateContentResponse }
  return wrapped.response ?? {}
}

/**
 * Pre-warm Code Assist onboarding for both executors. Call this during
 * boot to eliminate the onboarding round-trip from the first real request.
 * Non-blocking — fires in the background and caches the project ID.
 */
export function warmupCodeAssist(
  cliToken?: string,
  antigravityToken?: string,
): void {
  if (cliToken) {
    ensureCodeAssistReady(cliToken, 'cli').catch(() => {})
  }
  if (antigravityToken) {
    ensureCodeAssistReady(antigravityToken, 'antigravity').catch(() => {})
  }
}

/**
 * Parse a Code Assist SSE stream and yield unwrapped Gemini chunks.
 *
 * Handles two emission shapes the upstream proxy uses interchangeably:
 *   1. Per-line: one full JSON event per `data:` line (the classic
 *      Antigravity / Code Assist format). Yielded immediately so the UI
 *      streams as the bytes arrive — waiting for a blank-line separator
 *      stalls Antigravity, which doesn't always send one.
 *   2. Multi-line: a single JSON event split across consecutive `data:`
 *      lines, terminated by a blank line. We accumulate fragments until
 *      the joined payload parses (or the blank line forces a flush).
 *
 * Strategy: push each `data:` line into an accumulator and eagerly try
 * to JSON.parse the joined buffer. A successful parse yields and resets
 * the accumulator (handling shape 1); a failure keeps buffering until a
 * later fragment closes the JSON (handling shape 2). Blank lines and
 * end-of-stream flush whatever remains.
 *
 * `onEnvelope` sees each parsed event before unwrapping, for diagnostics
 * that need its `traceId` or an in-band `error`. It cannot change the chunks.
 */
export async function* parseCodeAssistSSE(
  body: ReadableStream<Uint8Array>,
  onEnvelope?: (envelope: object) => void,
): AsyncGenerator<GeminiStreamChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  const tryParseAccumulator = (): { done: boolean; chunks: GeminiStreamChunk[] } => {
    if (dataLines.length === 0) return { done: false, chunks: [] }

    const payload = dataLines.join('\n').trim()
    if (!payload) {
      dataLines = []
      return { done: false, chunks: [] }
    }
    if (payload === '[DONE]') {
      dataLines = []
      return { done: true, chunks: [] }
    }

    try {
      const wrapped = JSON.parse(payload) as {
        response?: GeminiStreamChunk
      }
      dataLines = []
      if (onEnvelope && wrapped && typeof wrapped === 'object') {
        try {
          onEnvelope(wrapped)
        } catch {
          // An observer must never drop or alter a chunk.
        }
      }
      return {
        done: false,
        chunks: wrapped.response ? [wrapped.response] : [],
      }
    } catch {
      return { done: false, chunks: [] }
    }
  }

  const flushEvent = (): { done: boolean; chunks: GeminiStreamChunk[] } => {
    const result = tryParseAccumulator()
    // Force-clear on flush so a malformed accumulated payload can't poison
    // the next event.
    dataLines = []
    return result
  }

  const processLine = (rawLine: string): { done: boolean; chunks: GeminiStreamChunk[] } => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.trim() === '') {
      return flushEvent()
    }

    if (!line.startsWith('data:')) {
      return { done: false, chunks: [] }
    }

    const value = line.slice(5)
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    return tryParseAccumulator()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE may deliver payload lines across chunks. Commit complete lines
      // here; processLine yields per-line events eagerly and accumulates
      // multi-line ones until they parse.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const event = processLine(rawLine)
        if (event.done) return
        for (const chunk of event.chunks) {
          yield chunk
        }
      }
    }

    buffer += decoder.decode()

    if (buffer) {
      for (const rawLine of buffer.split('\n')) {
        const event = processLine(rawLine)
        if (event.done) return
        for (const chunk of event.chunks) {
          yield chunk
        }
      }
    }

    const event = flushEvent()
    if (event.done) return
    for (const chunk of event.chunks) {
      yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}
