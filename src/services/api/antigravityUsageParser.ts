import {
  ANTIGRAVITY_MODELS,
  getAntigravityModelDisplayName,
} from './providers/gemini_code_assist.js'
import { parseAntigravityClaudeTier } from '../../utils/model/antigravityClaudeTiers.js'

export type AntigravityUsageMetric = {
  label: string
  usedPercent?: number
  summary?: string
  detail?: string
  resetsAt?: string | null
  /**
   * Model ids this row meters, as the request path spells them.
   *
   * `label` is Google's own `displayName` and is the wrong thing to identify a
   * row by: the status bar has to find the pool for the model THIS session is
   * running, and a label the vendor renames (or writes as "Fast" rather than
   * "Gemini 3.5 Flash (Low)") silently stops matching. When that match fails
   * the bar falls back to the tightest pool across every model, which reads as
   * someone else's 91% while this session sits at 25%. Carrying the ids makes
   * the match exact instead of textual.
   *
   * More than one where a pool is shared: the Gemini rows below are metered
   * together, so every id in the pool names the same row.
   */
  modelKeys?: readonly string[]
}

const ANTIGRAVITY_USAGE_MODEL_KEYS = [
  ...ANTIGRAVITY_MODELS.map(model => model.id),
  'gemini-3.5-flash',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-3-flash-agent',
  'gemini-3-flash-high',
  'gemini-3-flash-medium',
  'gemini-3-flash-low',
  'gpt-oss-120b-medium',
]

const ANTIGRAVITY_SHARED_GEMINI_QUOTA_MODELS = [
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
] as const

type AntigravityUsageRow = AntigravityUsageMetric & {
  modelKey: string
  remainingFraction: number
}

export function parseAntigravityUsage(data: unknown): AntigravityUsageMetric[] {
  const models = extractAntigravityModels(data)
  if (!models) return []

  const rows = antigravityUsageModelKeys(models)
    .map((modelKey) => parseAntigravityUsageRow(modelKey, models[modelKey]))
    .filter((metric): metric is AntigravityUsageRow => metric !== null)
  return finalizeAntigravityUsageRows(rows)
}

/**
 * Rows from `retrieveUserQuotaSummary`, the source of the Antigravity app's own
 * usage panel. Each model group (Gemini; Claude and GPT) has a weekly limit and
 * a 5-hour limit, both consumed in proportion to token cost. The per-model
 * fraction in fetchAvailableModels follows only the 5-hour window, so a spent
 * weekly limit never showed: live 2026-10-04 the Claude rows read 89% while
 * the weekly limit stood at 74%.
 *
 * One row per window, keyed by every model id in its group. Returns [] for a
 * response without groups, so callers can fall back to the per-model rows.
 */
export function parseAntigravityQuotaSummary(data: unknown): AntigravityUsageMetric[] {
  const groups = asRecord(data)?.groups
  if (!Array.isArray(groups)) return []

  const metrics: AntigravityUsageMetric[] = []
  for (const groupValue of groups) {
    const group = asRecord(groupValue)
    const buckets = group?.buckets
    if (!group || !Array.isArray(buckets)) continue
    const groupLabel = readString(group.displayName) ?? 'Antigravity models'
    for (const bucketValue of buckets) {
      const bucket = asRecord(bucketValue)
      const remaining = readNumber(bucket?.remainingFraction)
      if (!bucket || remaining === null || remaining < 0 || remaining > 1) continue
      const label = `${groupLabel} · ${quotaWindowLabel(bucket)}`
      metrics.push({
        ...metricFromAntigravityRemaining(
          label,
          remaining,
          validFutureIso(readString(bucket.resetTime)),
        ),
        modelKeys: quotaGroupModelKeys(readString(bucket.bucketId), groupLabel),
      })
    }
  }
  return metrics
}

/**
 * "session" marks the rolling window for the status bar, as it does for
 * Anthropic's and OpenAI's 5-hour windows (see isSessionWindowLabel).
 */
function quotaWindowLabel(bucket: Record<string, unknown>): string {
  switch (readString(bucket.window)) {
    case 'weekly':
      return 'weekly limit'
    case '5h':
      return '5-hour session limit'
    default:
      return readString(bucket.displayName)?.replace(/\s*remaining$/i, '') ?? 'limit'
  }
}

/** Model ids a quota group meters: `gemini-*` buckets, else Claude and GPT. */
function quotaGroupModelKeys(bucketId: string | null, groupLabel: string): string[] {
  const gemini = bucketId
    ? bucketId.toLowerCase().startsWith('gemini')
    : /gemini/i.test(groupLabel)
  return ANTIGRAVITY_USAGE_MODEL_KEYS.filter(
    key => key.toLowerCase().startsWith('gemini') === gemini,
  )
}

export function parseAntigravityQuotaBuckets(buckets: readonly unknown[]): AntigravityUsageMetric[] {
  const rows = buckets
    .map(parseAntigravityQuotaBucket)
    .filter((metric): metric is AntigravityUsageRow => metric !== null)
  return finalizeAntigravityUsageRows(rows)
}

function finalizeAntigravityUsageRows(rows: AntigravityUsageRow[]): AntigravityUsageMetric[] {
  const sharedGeminiQuota = pickSharedAntigravityGeminiQuota(rows)
  const byLabel = new Map<string, AntigravityUsageRow>()
  // Every model id that ended up on a given label, so collapsing two ids onto
  // one row cannot lose the id the session is actually running.
  const keysByLabel = new Map<string, Set<string>>()

  for (const row of rows) {
    setLowestRemainingRow(byLabel, row)
    const keys = keysByLabel.get(row.label) ?? new Set<string>()
    keys.add(row.modelKey)
    keysByLabel.set(row.label, keys)
  }

  if (sharedGeminiQuota) {
    for (const modelKey of ANTIGRAVITY_SHARED_GEMINI_QUOTA_MODELS) {
      const label = getAntigravityModelDisplayName(modelKey) ?? modelKey
      byLabel.set(label, {
        ...metricFromAntigravityRemaining(
          label,
          sharedGeminiQuota.remainingFraction,
          sharedGeminiQuota.resetsAt,
        ),
        modelKey,
        remainingFraction: sharedGeminiQuota.remainingFraction,
      })
      const keys = keysByLabel.get(label) ?? new Set<string>()
      keys.add(modelKey)
      keysByLabel.set(label, keys)
    }
  }

  return Array.from(byLabel.values())
    .map(row => toUsageMetric(row, keysByLabel.get(row.label)))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function setLowestRemainingRow(
  rowsByLabel: Map<string, AntigravityUsageRow>,
  row: AntigravityUsageRow,
): void {
  const existing = rowsByLabel.get(row.label)
  if (!existing || row.remainingFraction < existing.remainingFraction) {
    rowsByLabel.set(row.label, row)
  }
}

function parseAntigravityUsageRow(modelKey: string, value: unknown): AntigravityUsageRow | null {
  const info = asRecord(value)
  if (!info || info.isInternal === true || info.disabled === true) return null
  const quota = asRecord(info.quotaInfo)
  if (!quota) return null
  const remaining = readNumber(quota.remainingFraction)
  if (remaining === null || remaining < 0 || remaining > 1) return null
  const display = claudeTierUsageLabel(modelKey)
    ?? sanitizeAntigravityUsageLabel(readString(info.displayName))
    ?? getAntigravityModelDisplayName(modelKey)
    ?? modelKey
  const reset = validFutureIso(readString(quota.resetTime))
  return {
    ...metricFromAntigravityRemaining(
      display,
      remaining,
      reset ?? epochSecondsToIso(quota.resetAt),
    ),
    modelKey,
    remainingFraction: remaining,
  }
}

function parseAntigravityQuotaBucket(value: unknown): AntigravityUsageRow | null {
  const bucket = asRecord(value)
  const modelKey = readString(bucket?.modelId)
  if (!modelKey) return null
  const remaining = readNumber(bucket?.remainingFraction)
  if (remaining === null || remaining < 0 || remaining > 1) return null
  const label = claudeTierUsageLabel(modelKey)
    ?? getAntigravityModelDisplayName(modelKey)
    ?? modelKey
  const reset = validFutureIso(readString(bucket?.resetTime))
  return {
    ...metricFromAntigravityRemaining(label, remaining, reset),
    modelKey,
    remainingFraction: remaining,
  }
}

/**
 * One row per Claude tier model rather than one per level: its three level
 * ids are metered together (same fraction, same reset), so the rows they
 * would get are copies. The shared label merges them below, keeping every
 * level id as a key the status bar can match.
 */
function claudeTierUsageLabel(modelKey: string): string | null {
  return parseAntigravityClaudeTier(modelKey)?.model.name ?? null
}

function metricFromAntigravityRemaining(
  label: string,
  remainingFraction: number,
  resetsAt?: string | null,
): AntigravityUsageMetric {
  return {
    label,
    usedPercent: clampPercent((1 - remainingFraction) * 100),
    summary: `${Math.round(clampPercent(remainingFraction * 100))}% remaining`,
    resetsAt,
  }
}

function toUsageMetric(
  row: AntigravityUsageRow,
  modelKeys?: ReadonlySet<string>,
): AntigravityUsageMetric {
  const keys = new Set<string>(modelKeys ?? [])
  keys.add(row.modelKey)
  return {
    label: row.label,
    usedPercent: row.usedPercent,
    summary: row.summary,
    detail: row.detail,
    resetsAt: row.resetsAt,
    modelKeys: Array.from(keys),
  }
}

function pickSharedAntigravityGeminiQuota(rows: AntigravityUsageRow[]): AntigravityUsageRow | null {
  const sharedRows = rows.filter(row => isSharedAntigravityGeminiQuotaModel(row.modelKey, row.label))
  if (sharedRows.length === 0) return null
  return sharedRows.reduce((best, row) =>
    row.remainingFraction < best.remainingFraction ? row : best
  )
}

function isSharedAntigravityGeminiQuotaModel(modelKey: string, label: string): boolean {
  const normalized = modelKey.toLowerCase().replace(/^models\//, '')
  if (
    normalized === 'gemini-3.1-pro-high'
    || normalized === 'gemini-3.1-pro-low'
    || normalized === 'gemini-3.5-flash-high'
    || normalized === 'gemini-3.5-flash-medium'
    || normalized === 'gemini-3.5-flash-low'
    || normalized === 'gemini-3.5-flash-extra-low'
    || normalized === 'gemini-3-flash-agent'
    || normalized === 'gemini-3-flash'
  ) {
    return true
  }

  const combined = `${normalized} ${label}`
    .toLowerCase()
    .replace(/_/g, '-')
  return /gemini[-\s]3\.1[-\s]pro/.test(combined)
    || /gemini[-\s]3\.5[-\s]flash/.test(combined)
    || /gemini[-\s]3[-\s]flash\b/.test(combined)
}

function antigravityUsageModelKeys(models: Record<string, unknown>): string[] {
  const keys = new Set<string>(ANTIGRAVITY_USAGE_MODEL_KEYS)
  for (const [modelKey, info] of Object.entries(models)) {
    if (isAntigravity35FlashUsageModel(modelKey, info)) {
      keys.add(modelKey)
    }
  }
  return Array.from(keys)
}

function isAntigravity35FlashUsageModel(modelKey: string, value: unknown): boolean {
  const info = asRecord(value)
  const displayName = readString(info?.displayName)
  const modelName = readString(info?.modelName)
  const combined = [modelKey, displayName, modelName]
    .filter((part): part is string => !!part)
    .join(' ')
    .toLowerCase()
    .replace(/_/g, '-')
  return /gemini[-\s]3\.5[-\s]flash/.test(combined)
}

function sanitizeAntigravityUsageLabel(label: string | null): string | null {
  if (!label) return null
  return label
    .replace(/\s*(?:\u00c2\u00b7|\u00b7)\s*thinking(?=\s*\(via Antigravity\))/i, '')
    .replace(/\s*\(via Antigravity\)/i, '')
    .trim()
}

export function extractAntigravityModels(data: unknown): Record<string, unknown> | null {
  const root = asRecord(data)
  const response = asRecord(root?.response)
  const wrappedData = asRecord(root?.data)
  return asRecord(root?.models)
    ?? asRecord(response?.models)
    ?? asRecord(wrappedData?.models)
}

export function hasAntigravity35FlashUsagePair(models: Record<string, unknown>): boolean {
  let hasHigh = false
  let hasMedium = false
  let hasLow = false
  for (const [modelKey, value] of Object.entries(models)) {
    if (!isAntigravity35FlashUsageModel(modelKey, value)) continue
    const display = readString(asRecord(value)?.displayName)?.toLowerCase() ?? ''
    hasHigh ||= /\bhigh\b/.test(display) || modelKey === 'gemini-3-flash-agent'
    hasMedium ||= /\bmedium\b/.test(display) || modelKey === 'gemini-3.5-flash-low'
    hasLow ||= /\blow\b/.test(display) || modelKey === 'gemini-3.5-flash-extra-low'
  }
  return hasHigh && hasMedium && hasLow
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

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}
