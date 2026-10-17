/**
 * xAI account and billing reads, shared by /login and /usage.
 *
 * Two credentials, two hosts (docs.x.ai/developers/management-api-guide):
 *
 *   - The API key (inference, https://api.x.ai/v1) can describe itself:
 *     `GET /v1/api-key` names the key, its team, and whether the key or the
 *     team is blocked or disabled. It cannot read balances.
 *   - A management key (console → Settings → Management Keys, host
 *     https://management-api.x.ai) reads billing: prepaid balance, the
 *     current postpaid invoice, the spending limit, and usage analytics.
 *     Optional: /usage shows key status without it.
 */

import { loadProviderKey } from './auth/api_key_manager.js'

const TIMEOUT_MS = 10_000
export const XAI_MANAGEMENT_BASE_URL = 'https://management-api.x.ai'

export interface XaiApiKeyInfo {
  name?: string
  redactedKey?: string
  teamId?: string
  apiKeyBlocked: boolean
  apiKeyDisabled: boolean
  teamBlocked: boolean
  acls: string[]
}

export type XaiApiKeyCheck =
  | { ok: true; info: XaiApiKeyInfo }
  | { ok: false; status: number; message: string }

function managementBaseUrl(): string {
  return (process.env.XAI_MANAGEMENT_BASE_URL ?? XAI_MANAGEMENT_BASE_URL).replace(/\/+$/, '')
}

/** XAI_MANAGEMENT_API_KEY, else the key /login stored. */
export function getXaiManagementKey(): string | null {
  return process.env.XAI_MANAGEMENT_API_KEY?.trim() || loadProviderKey('xai_management') || null
}

function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim()) return record.error.trim()
    const nested = record.error as { message?: unknown } | undefined
    if (typeof nested?.message === 'string') return nested.message
    if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  }
  return fallback
}

export function parseXaiApiKeyInfo(body: unknown): XaiApiKeyInfo | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  if (text(record.api_key_id) === undefined && text(record.redacted_api_key) === undefined) return null
  return {
    name: text(record.name),
    redactedKey: text(record.redacted_api_key),
    teamId: text(record.team_id),
    apiKeyBlocked: record.api_key_blocked === true,
    apiKeyDisabled: record.api_key_disabled === true,
    teamBlocked: record.team_blocked === true,
    acls: Array.isArray(record.acls) ? record.acls.filter((acl): acl is string => typeof acl === 'string') : [],
  }
}

/** `GET /v1/api-key`: whether this key works, and what it is. */
export async function checkXaiApiKey(apiKey: string, baseUrl: string): Promise<XaiApiKeyCheck> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api-key`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    return { ok: false, status: response.status, message: errorText(body, `HTTP ${response.status}`) }
  }
  const info = parseXaiApiKeyInfo(body)
  if (!info) return { ok: false, status: response.status, message: 'xAI returned an unrecognized API key response.' }
  return { ok: true, info }
}

/** Why a key that authenticates still cannot run requests, if it cannot. */
export function xaiKeyBlockReason(info: XaiApiKeyInfo): string | undefined {
  if (info.teamBlocked) return 'the xAI team is blocked (check billing in the xAI console)'
  if (info.apiKeyBlocked) return 'the API key is blocked'
  if (info.apiKeyDisabled) return 'the API key is disabled'
  return undefined
}

/** `GET /auth/management-keys/validation`: true when the key is a management key. */
export async function validateXaiManagementKey(managementKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${managementBaseUrl()}/auth/management-keys/validation`, {
      headers: { Authorization: `Bearer ${managementKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.ok) return { ok: true }
    const body = await response.json().catch(() => null)
    return { ok: false, message: `${errorText(body, `HTTP ${response.status}`)} (${response.status})` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

// ─── Billing ─────────────────────────────────────────────────────────

/** `{ "val": "<USD cents>" }` → dollars. */
function centsValue(value: unknown): number | undefined {
  const raw = value && typeof value === 'object' ? (value as { val?: unknown }).val : value
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed / 100 : undefined
}

/**
 * Prepaid credit left. Purchases are recorded negative and spend positive,
 * so the running total is negative while credit remains.
 */
export function parseXaiPrepaidBalance(body: unknown): number | undefined {
  const total = centsValue((body as { total?: unknown } | null)?.total)
  return total === undefined ? undefined : Math.max(0, -total)
}

export interface XaiInvoicePreview {
  /** Postpaid amount due this cycle, after VAT. */
  amountDue?: number
  /** Effective monthly spending limit. */
  spendingLimit?: number
  year?: number
  month?: number
}

export function parseXaiInvoicePreview(body: unknown): XaiInvoicePreview | null {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const invoice = record.coreInvoice as Record<string, unknown> | undefined
  const cycle = record.billingCycle as { year?: unknown; month?: unknown } | undefined
  const preview: XaiInvoicePreview = {
    amountDue: centsValue(invoice?.amountAfterVat) ?? centsValue(invoice?.totalWithCorr),
    spendingLimit: centsValue(record.effectiveSpendingLimit),
    ...(typeof cycle?.year === 'number' && { year: cycle.year }),
    ...(typeof cycle?.month === 'number' && { month: cycle.month }),
  }
  return preview.amountDue === undefined && preview.spendingLimit === undefined ? null : preview
}

export interface XaiUsageLine {
  label: string
  usd: number
}

/** Sum each grouped series of a `POST …/usage` response, largest first. */
export function parseXaiUsageAnalytics(body: unknown): XaiUsageLine[] {
  const series = (body as { timeSeries?: unknown } | null)?.timeSeries
  if (!Array.isArray(series)) return []
  const lines: XaiUsageLine[] = []
  for (const entry of series) {
    const record = entry as { group?: unknown; groupLabels?: unknown; dataPoints?: unknown } | null
    const labels = Array.isArray(record?.groupLabels) ? record!.groupLabels : Array.isArray(record?.group) ? record!.group : []
    const label = labels.filter((value): value is string => typeof value === 'string').join(' ') || 'xAI API'
    let usd = 0
    for (const point of Array.isArray(record?.dataPoints) ? record!.dataPoints : []) {
      const values = (point as { values?: unknown } | null)?.values
      if (Array.isArray(values) && typeof values[0] === 'number' && Number.isFinite(values[0])) usd += values[0]
    }
    if (usd > 0) lines.push({ label, usd })
  }
  return lines.sort((a, b) => b.usd - a.usd)
}

function localTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

async function managementGet(path: string, managementKey: string): Promise<unknown> {
  const response = await fetch(`${managementBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${managementKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${errorText(body, `HTTP ${response.status}`)} (${response.status})`)
  return body
}

export interface XaiBillingSnapshot {
  prepaidRemaining?: number
  invoice?: XaiInvoicePreview
  /** API spend since the start of this calendar month, per model line. */
  monthToDate?: XaiUsageLine[]
  /** Reads that failed, as `what: why`. */
  errors: string[]
}

/** Everything the management key can say about this team's money. */
export async function fetchXaiBilling(managementKey: string, teamId: string, now = new Date()): Promise<XaiBillingSnapshot> {
  const team = encodeURIComponent(teamId)
  const snapshot: XaiBillingSnapshot = { errors: [] }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/GMT'

  await Promise.all([
    managementGet(`/v1/billing/teams/${team}/prepaid/balance`, managementKey)
      .then(body => { snapshot.prepaidRemaining = parseXaiPrepaidBalance(body) })
      .catch(error => { snapshot.errors.push(`prepaid balance: ${error instanceof Error ? error.message : String(error)}`) }),
    managementGet(`/v1/billing/teams/${team}/postpaid/invoice/preview`, managementKey)
      .then(body => { snapshot.invoice = parseXaiInvoicePreview(body) ?? undefined })
      .catch(error => { snapshot.errors.push(`invoice preview: ${error instanceof Error ? error.message : String(error)}`) }),
    fetch(`${managementBaseUrl()}/v1/billing/teams/${team}/usage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managementKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        analyticsRequest: {
          timeRange: { startTime: localTimestamp(monthStart), endTime: localTimestamp(now), timezone },
          timeUnit: 'TIME_UNIT_NONE',
          values: [{ name: 'usd', aggregation: 'AGGREGATION_SUM' }],
          groupBy: ['description'],
          filters: [],
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async response => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(`${errorText(body, `HTTP ${response.status}`)} (${response.status})`)
        snapshot.monthToDate = parseXaiUsageAnalytics(body)
      })
      .catch(error => { snapshot.errors.push(`usage: ${error instanceof Error ? error.message : String(error)}`) }),
  ])
  return snapshot
}
