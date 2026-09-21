/**
 * Bounded, cursor-aware MCP list discovery, and a discovery cache that cannot
 * turn a failed listing into an empty catalog.
 *
 * `tools/list`, `resources/list` and `prompts/list` are paginated in the MCP
 * protocol: a result may carry `nextCursor`, and the caller is expected to ask
 * again until it does not. Tau read one page, so a server publishing more
 * tools than its page size had the rest silently missing — the model then saw
 * a catalog that did not match what the server offered.
 *
 * Pagination is bounded in three ways, because the cursor comes from the
 * server and a buggy or hostile one must not be able to hang startup:
 *
 * - a page limit, so a server that always returns a cursor terminates;
 * - an item limit, so a server that returns real items forever terminates;
 * - a repeated-cursor check, so a server that hands back the cursor it was
 *   given (or cycles between two) terminates instead of looping.
 *
 * Hitting a bound is reported, not hidden: the result says the listing is
 * incomplete and why, so the caller can keep the items it did get while
 * recording that the catalog is not the whole catalog.
 */

import { logMCPError } from '../../utils/log.js'

export const MAX_DISCOVERY_PAGES = 100
export const MAX_DISCOVERY_ITEMS = 10_000

export type DiscoveryTruncation =
  | 'page-limit'
  | 'item-limit'
  | 'repeated-cursor'

export type PaginatedListResult<T> = {
  items: T[]
  pages: number
  /** Set when a bound stopped the listing before the server ran out. */
  truncatedBy?: DiscoveryTruncation
}

/**
 * A listing stopped early by one of the bounds.
 *
 * Thrown rather than returned so an incomplete list cannot be mistaken for a
 * complete one. Every caller of `listAllPages` publishes its result as the
 * server's catalog, so returning a partial list would cache a truncated
 * subset as though the server had nothing more — and a later complete
 * listing could be replaced by a truncated one with no way to tell. The
 * discovery cache keeps the previous complete catalog on a throw, which is
 * the right outcome here.
 */
export class IncompleteDiscoveryError extends Error {
  constructor(
    readonly serverName: string,
    readonly collection: string,
    readonly truncatedBy: DiscoveryTruncation,
    readonly partialCount: number,
  ) {
    super(
      `${collection} for "${serverName}" is incomplete (${truncatedBy}); ` +
        `stopped after ${partialCount} item(s)`,
    )
    this.name = 'IncompleteDiscoveryError'
  }
}

type PageFetcher<T> = (
  cursor: string | undefined,
) => Promise<{ items: T[]; nextCursor?: string }>

/**
 * Follow `nextCursor` until the server stops supplying one.
 *
 * Rejects if a page request rejects: a failed page is a discovery failure, not
 * an empty catalog. The caller decides whether to keep a previous good result.
 *
 * Also rejects with `IncompleteDiscoveryError` when a bound stops the listing
 * early, for the same reason — see that class.
 */
export async function listAllPages<T>(
  serverName: string,
  collection: string,
  fetchPage: PageFetcher<T>,
): Promise<PaginatedListResult<T>> {
  const items: T[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let pages = 0

  for (;;) {
    const page = await fetchPage(cursor)
    pages++
    items.push(...page.items)

    const next = page.nextCursor
    if (next === undefined || next === '') {
      return { items, pages }
    }

    if (seenCursors.has(next)) {
      logMCPError(
        serverName,
        `${collection}: server repeated a cursor after ${pages} page(s); stopping with ${items.length} item(s)`,
      )
      throw new IncompleteDiscoveryError(
        serverName,
        collection,
        'repeated-cursor',
        items.length,
      )
    }
    seenCursors.add(next)

    if (pages >= MAX_DISCOVERY_PAGES) {
      logMCPError(
        serverName,
        `${collection}: stopped after ${MAX_DISCOVERY_PAGES} pages with ${items.length} item(s); listing is incomplete`,
      )
      throw new IncompleteDiscoveryError(
        serverName,
        collection,
        'page-limit',
        items.length,
      )
    }

    if (items.length >= MAX_DISCOVERY_ITEMS) {
      logMCPError(
        serverName,
        `${collection}: stopped at ${items.length} items; listing is incomplete`,
      )
      throw new IncompleteDiscoveryError(
        serverName,
        collection,
        'item-limit',
        items.length,
      )
    }

    cursor = next
  }
}

/**
 * A discovery cache that never turns a failure into a successful empty result.
 *
 * `memoizeWithLRU` caches the promise it was handed. The list fetchers used to
 * swallow their errors and return `[]`, so one failed `tools/list` — a server
 * restarting, a transient network error — was memoized as "this server has no
 * tools" and stayed that way until something explicitly cleared the entry. The
 * server's tools disappeared from the catalog with no state saying so.
 *
 * This wrapper instead:
 *
 * - shares one in-flight operation per key, so concurrent callers do not each
 *   issue their own list request;
 * - caches only successful results;
 * - on failure, returns the last successful result for that key if there is
 *   one, and rethrows only when there is nothing known-good to fall back to,
 *   so the caller can record a real discovery failure.
 *
 * `cache.delete` marks the entry stale rather than discarding it: the callers
 * that invalidate — a `list_changed` notification, a reconnect — do so to
 * force a refetch, and if that refetch fails, the previous complete catalog is
 * still the best knowledge available. Discarding first would turn every failed
 * refresh into a server whose tools vanished. `cache.clear` is the real
 * discard, for when the previous answer is no longer ours to serve.
 *
 * Publication is revision-guarded, because invalidation can land while a list
 * is already in flight:
 *
 * - a `discard` revokes the in-flight operation's right to publish, so a
 *   removed server or a switched account cannot have its old catalog
 *   resurrected by a listing that was already running;
 * - a `delete` during a refresh means the result the refresh returns predates
 *   the change that prompted it. It is published, because it is still the
 *   best complete knowledge available, but left marked stale so the next
 *   call refetches instead of treating it as current. Otherwise a
 *   `list_changed` arriving mid-refresh was simply lost.
 *
 * In-flight work is kept in its own map rather than in the bounded cache: an
 * LRU that evicts completed values would otherwise be able to evict an
 * unresolved operation and let a duplicate one start.
 */
export function memoizeDiscovery<Args extends unknown[], Result>(
  fetch: (...args: Args) => Promise<Result>,
  keyOf: (...args: Args) => string,
  maxEntries: number,
): ((...args: Args) => Promise<Result>) & {
  cache: {
    clear: () => void
    /**
     * Mark this key's entry stale: the next call refetches, but a refetch
     * that fails still falls back to this value.
     */
    delete: (key: string) => boolean
    /** Discard this key's entry outright — there is nothing to fall back to. */
    discard: (key: string) => boolean
    /** The last successful result for this key, if one is still cached. */
    get: (key: string) => Result | undefined
  }
} {
  type Entry = { value: Result; stale: boolean }
  const lastGood = new Map<string, Entry>()
  const inFlight = new Map<string, { promise: Promise<Result>; revoked: boolean }>()
  /**
   * Bumped by every invalidation. An operation captures it at the start and
   * compares on publication, so it can tell whether the world changed while
   * it was listing.
   */
  const revisions = new Map<string, number>()

  const bumpRevision = (key: string) => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }

  const evictOldest = () => {
    while (lastGood.size > maxEntries) {
      const oldest = lastGood.keys().next()
      if (oldest.done) return
      lastGood.delete(oldest.value)
    }
  }

  const memoized = async (...args: Args): Promise<Result> => {
    const key = keyOf(...args)
    const pending = inFlight.get(key)
    if (pending) return pending.promise
    const cached = lastGood.get(key)
    if (cached && !cached.stale) return cached.value

    // The fallback is decided inside the shared operation, not by each
    // caller after awaiting it. Deciding it per caller gave concurrent
    // waiters on one failing refresh different answers — the first received
    // the last-good catalog while the others received the raw rejection — so
    // one caller could dispose a connection while another published success
    // from the very same refresh.
    const startedAt = revisions.get(key) ?? 0
    const owner = { promise: undefined as unknown as Promise<Result>, revoked: false }
    const operation = (async () => {
      try {
        const value = await fetch(...args)
        const currentRevision = revisions.get(key) ?? 0
        if (owner.revoked) {
          // Discarded while this was listing: the entry is no longer ours to
          // serve. Hand the value to the callers waiting on this operation,
          // but publish nothing.
          return value
        }
        // Re-insert so the key moves to the end: Map iterates in insertion
        // order, which is what makes evictOldest least-recently-succeeded.
        lastGood.delete(key)
        lastGood.set(key, {
          value,
          // Invalidated while this was listing, so the result predates the
          // change that prompted it: publish it, but keep it stale so the
          // next call refetches.
          stale: currentRevision !== startedAt,
        })
        evictOldest()
        return value
      } catch (error) {
        // A failed refresh is not evidence that the catalog is empty. Serve
        // the last complete one and leave it marked stale, so the next call
        // tries again rather than settling for it permanently.
        const known = !owner.revoked ? lastGood.get(key) : undefined
        if (known) return known.value
        throw error
      }
    })()

    // Registered before anything awaits it, and cleared from a separate
    // callback rather than a finally inside the operation: a fetch that threw
    // synchronously would otherwise run its cleanup before this set and
    // strand the entry.
    owner.promise = operation
    inFlight.set(key, owner)
    void operation
      .catch(() => {})
      .then(() => {
        if (inFlight.get(key) === owner) {
          inFlight.delete(key)
        }
      })

    return operation
  }

  memoized.cache = {
    clear: () => {
      for (const key of lastGood.keys()) bumpRevision(key)
      for (const owner of inFlight.values()) owner.revoked = true
      inFlight.clear()
      lastGood.clear()
    },
    delete: (key: string) => {
      bumpRevision(key)
      const entry = lastGood.get(key)
      if (!entry) return false
      entry.stale = true
      return true
    },
    discard: (key: string) => {
      bumpRevision(key)
      // Revoke any listing already running for this key, so its result
      // cannot reinsert the entry being discarded.
      const owner = inFlight.get(key)
      if (owner) owner.revoked = true
      inFlight.delete(key)
      return lastGood.delete(key)
    },
    get: (key: string) => lastGood.get(key)?.value,
  }

  return memoized
}
