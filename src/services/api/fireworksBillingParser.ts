/**
 * Fireworks billing-summary parsing.
 *
 * Dependency-free on purpose, for the same reason providerUsageCoverage.ts is:
 * providerUsage.ts pulls in every provider module, and neither the tests nor a
 * caller that only wants the arithmetic should have to drag that along.
 *
 * Fireworks has no credit-balance endpoint. Every plausible name — /credits,
 * /billing/credits, /creditBalance, /creditGrants, /transactions, /invoices —
 * answers 404, GetAccount carries no money field (and ignores readMask), and
 * inference responses publish no balance header. Spend is the only dollar
 * figure the API will report, so that is what /usage shows; the prepaid
 * balance stays one click away on the billing page.
 */

/** google.type.Money, as the gateway serialises it. */
type Money = {
  units?: unknown
  nanos?: unknown
}

type LineItem = {
  totalCost?: unknown
}

type UsageBucket = {
  startTime?: unknown
  lineItems?: unknown
}

export type FireworksSpend = {
  /** Dollars over the whole requested window. */
  total: number
  /**
   * Per-day totals, present only when the request asked for DAILY
   * granularity. A bucket is not always a whole day — Fireworks splits one
   * where a rate changes mid-day — so they are matched by start time rather
   * than counted back from the end.
   */
  buckets: Array<{ startTime: string; total: number }>
}

/**
 * A Money value in dollars. Fireworks prices per token in nanos, so a unit
 * amount arrives as `{units: "0", nanos: 260}` and only a summed line item
 * ever reaches whole cents.
 */
function toDollars(value: unknown): number {
  const money = value as Money | null | undefined
  const units = Number(money?.units ?? 0)
  const nanos = Number(money?.nanos ?? 0)
  if (!Number.isFinite(units) || !Number.isFinite(nanos)) return 0
  return units + nanos / 1e9
}

function sumLineItems(items: unknown): number {
  if (!Array.isArray(items)) return 0
  return items.reduce<number>(
    (total, item) => total + toDollars((item as LineItem | null)?.totalCost),
    0,
  )
}

/**
 * Read a `billing/summary` response. The costs arrive twice — flat `lineItems`
 * covering the whole window, and `usageBuckets` when a granularity was asked
 * for — so the total comes from the flat list, and the buckets exist only to
 * carve a single day back out of the month.
 */
export function parseFireworksBillingSummary(data: unknown): FireworksSpend {
  const payload = data as {
    lineItems?: unknown
    usageBuckets?: unknown
  } | null | undefined
  const rawBuckets = payload?.usageBuckets
  const buckets = Array.isArray(rawBuckets)
    ? rawBuckets.flatMap(raw => {
        const bucket = raw as UsageBucket | null
        return typeof bucket?.startTime === 'string'
          ? [{ startTime: bucket.startTime, total: sumLineItems(bucket.lineItems) }]
          : []
      })
    : []
  return { total: sumLineItems(payload?.lineItems), buckets }
}

/** Spend in the buckets beginning at or after `since` — i.e. today's share. */
export function sumFireworksSpendSince(spend: FireworksSpend, since: string): number {
  const from = new Date(since).getTime()
  if (!Number.isFinite(from)) return 0
  return spend.buckets.reduce((total, bucket) => {
    const start = new Date(bucket.startTime).getTime()
    return Number.isFinite(start) && start >= from ? total + bucket.total : total
  }, 0)
}

/**
 * Widest window the gateway will serve. Measured, not documented: a summary
 * spanning 364 days returns costs, 365 returns `503 billing data is
 * temporarily unavailable` — every time, for any start date. Lifetime spend is
 * therefore a year at most, and the row says so when it is clamped.
 */
export const FIREWORKS_MAX_SUMMARY_DAYS = 364

const DAY_MS = 24 * 60 * 60_000

export type FireworksSummaryRange = {
  /** Midnight UTC today; the lower bound of the "Today" row. */
  dayStart: string
  /** Midnight UTC on the 1st of the current month. */
  monthStart: string
  /** Exclusive upper bound — Fireworks omits costs dated on the end date, so
   * this is tomorrow if today is to count. */
  end: string
  /** Lower bound of the lifetime window, clamped to what the gateway serves. */
  lifetimeStart: string
  /** Whether `lifetimeStart` still reaches the account's creation. */
  lifetimeIsComplete: boolean
}

/**
 * The three windows the card needs, in UTC. Fireworks reads only the date
 * portion of each bound and has no timezone parameter on this endpoint, so the
 * day it bills is the UTC day whatever the terminal's clock says.
 */
export function fireworksSummaryRange(
  now: Date,
  createTime: string | null,
): FireworksSummaryRange {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const end = midnight + DAY_MS
  const floor = end - FIREWORKS_MAX_SUMMARY_DAYS * DAY_MS
  const created = createTime === null ? NaN : new Date(createTime).getTime()
  const complete = Number.isFinite(created) && created >= floor
  return {
    dayStart: new Date(midnight).toISOString(),
    monthStart: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString(),
    end: new Date(end).toISOString(),
    lifetimeStart: new Date(complete ? created : floor).toISOString(),
    lifetimeIsComplete: complete,
  }
}
