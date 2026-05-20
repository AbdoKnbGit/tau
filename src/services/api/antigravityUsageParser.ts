import {
  ANTIGRAVITY_MODELS,
  getAntigravityModelDisplayName,
} from './providers/gemini_code_assist.js'

export type AntigravityUsageMetric = {
  label: string
  usedPercent?: number
  summary?: string
  detail?: string
  resetsAt?: string | null
}

const ANTIGRAVITY_USAGE_MODEL_KEYS = [
  ...ANTIGRAVITY_MODELS.map(model => model.id),
  'gemini-3.5-flash',
  'gemini-3.5-flash-low',
  'gemini-3-flash-agent',
  'gemini-3-flash-high',
  'gemini-3-flash-medium',
  'gemini-3-flash-low',
  'gpt-oss-120b-medium',
]

const ANTIGRAVITY_SHARED_GEMINI_QUOTA_MODELS = [
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
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

export function parseAntigravityQuotaBuckets(buckets: readonly unknown[]): AntigravityUsageMetric[] {
  const rows = buckets
    .map(parseAntigravityQuotaBucket)
    .filter((metric): metric is AntigravityUsageRow => metric !== null)
  return finalizeAntigravityUsageRows(rows)
}

function finalizeAntigravityUsageRows(rows: AntigravityUsageRow[]): AntigravityUsageMetric[] {
  const sharedGeminiQuota = pickSharedAntigravityGeminiQuota(rows)
  const byLabel = new Map<string, AntigravityUsageRow>()

  for (const row of rows) {
    setLowestRemainingRow(byLabel, row)
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
    }
  }

  return Array.from(byLabel.values())
    .map(toUsageMetric)
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
  const display = getAntigravityModelDisplayName(modelKey)
    ?? sanitizeAntigravityUsageLabel(readString(info.displayName))
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
  const label = getAntigravityModelDisplayName(modelKey) ?? modelKey
  const reset = validFutureIso(readString(bucket?.resetTime))
  return {
    ...metricFromAntigravityRemaining(label, remaining, reset),
    modelKey,
    remainingFraction: remaining,
  }
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

function toUsageMetric(row: AntigravityUsageRow): AntigravityUsageMetric {
  return {
    label: row.label,
    usedPercent: row.usedPercent,
    summary: row.summary,
    detail: row.detail,
    resetsAt: row.resetsAt,
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
  for (const [modelKey, value] of Object.entries(models)) {
    if (!isAntigravity35FlashUsageModel(modelKey, value)) continue
    const display = readString(asRecord(value)?.displayName)?.toLowerCase() ?? ''
    hasHigh ||= /\bhigh\b/.test(display) || modelKey === 'gemini-3-flash-agent'
    hasMedium ||= /\bmedium\b/.test(display) || modelKey === 'gemini-3.5-flash-low'
  }
  return hasHigh && hasMedium
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
