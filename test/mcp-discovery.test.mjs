// Cursor-aware MCP list discovery and the discovery cache.
//
// Exercised through the built bundle, like core-tool-contracts.test.mjs, so
// the production implementation is what runs.

import assert from 'node:assert/strict'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const distPath = resolve('dist/tau.mjs')
const auditPath = join(
  dirname(distPath),
  `.mcp-discovery-audit-${process.pid}-${Date.now()}.mjs`,
)
let source = readFileSync(distPath, 'utf8')
source = source.replace(/\nvoid main\d*\(\);\r?\n/, '\n')
source += `
export function __mcpDiscovery() {
  init_discovery();
  return { listAllPages, memoizeDiscovery, IncompleteDiscoveryError,
    MAX_DISCOVERY_PAGES, MAX_DISCOVERY_ITEMS };
}
`
writeFileSync(auditPath, source)

let d
try {
  const module = await import(pathToFileURL(auditPath).href)
  d = module.__mcpDiscovery()
} finally {
  unlinkSync(auditPath)
}

/** A fixture server whose list is split across pages. */
function pagedServer(items, pageSize) {
  const calls = []
  return {
    calls,
    fetchPage: async cursor => {
      calls.push(cursor)
      const start = cursor === undefined ? 0 : Number(cursor)
      const slice = items.slice(start, start + pageSize)
      const next = start + pageSize
      return {
        items: slice,
        nextCursor: next < items.length ? String(next) : undefined,
      }
    },
  }
}

test('a single-page listing asks once and returns everything', async () => {
  const server = pagedServer(['a', 'b'], 10)
  const result = await d.listAllPages('fixture', 'tools/list', server.fetchPage)
  assert.deepEqual(result.items, ['a', 'b'])
  assert.equal(result.pages, 1)
  assert.equal(result.truncatedBy, undefined)
  assert.deepEqual(server.calls, [undefined])
})

test('a tool on page two is discovered', async () => {
  // The defect this replaces: one page was read, so everything past it was
  // missing from the catalog with nothing saying so.
  const server = pagedServer(['first', 'second', 'third'], 2)
  const result = await d.listAllPages('fixture', 'tools/list', server.fetchPage)
  assert.deepEqual(result.items, ['first', 'second', 'third'])
  assert.equal(result.pages, 2)
  assert.equal(result.truncatedBy, undefined)
  // The second request carried the cursor the first returned.
  assert.deepEqual(server.calls, [undefined, '2'])
})

test('a valid empty page with a continuation is followed', async () => {
  let call = 0
  const result = await d.listAllPages('fixture', 'tools/list', async () => {
    call++
    if (call === 1) return { items: [], nextCursor: 'more' }
    return { items: ['late'] }
  })
  assert.deepEqual(result.items, ['late'])
  assert.equal(result.pages, 2)
})

test('an empty-string cursor ends the listing', async () => {
  // Treated as "no more", not as a cursor to send back.
  const result = await d.listAllPages('fixture', 'tools/list', async () => ({
    items: ['only'],
    nextCursor: '',
  }))
  assert.deepEqual(result.items, ['only'])
  assert.equal(result.pages, 1)
})

test('a repeated cursor stops the listing instead of looping', async () => {
  // An incomplete listing rejects rather than returning a partial list:
  // every caller publishes the result as the server's catalog, so a
  // truncated subset must not be cacheable as a complete one.
  let calls = 0
  await assert.rejects(
    d.listAllPages('fixture', 'tools/list', async () => {
      calls++
      return { items: [`item-${calls}`], nextCursor: 'same' }
    }),
    error => {
      assert.equal(error.name, 'IncompleteDiscoveryError')
      assert.equal(error.truncatedBy, 'repeated-cursor')
      assert.equal(error.partialCount, 2)
      return true
    },
  )
  // Two requests: the first supplies the cursor, the second repeats it.
  assert.equal(calls, 2)
})

test('a cursor that cycles between two values stops the listing', async () => {
  let calls = 0
  await assert.rejects(
    d.listAllPages('fixture', 'tools/list', async () => {
      calls++
      return { items: ['x'], nextCursor: calls % 2 === 0 ? 'a' : 'b' }
    }),
    { name: 'IncompleteDiscoveryError', truncatedBy: 'repeated-cursor' },
  )
  assert.equal(calls < 10, true, `looped ${calls} times`)
})

test('a server that always returns a fresh cursor stops at the page limit', async () => {
  let calls = 0
  await assert.rejects(
    d.listAllPages('fixture', 'tools/list', async () => {
      calls++
      return { items: ['x'], nextCursor: `cursor-${calls}` }
    }),
    { name: 'IncompleteDiscoveryError', truncatedBy: 'page-limit' },
  )
  assert.equal(calls, d.MAX_DISCOVERY_PAGES)
})

test('a server returning huge pages stops at the item limit', async () => {
  const page = Array.from({ length: 6_000 }, (_, i) => `t${i}`)
  let calls = 0
  await assert.rejects(
    d.listAllPages('fixture', 'tools/list', async () => {
      calls++
      return { items: page, nextCursor: `cursor-${calls}` }
    }),
    error => {
      assert.equal(error.truncatedBy, 'item-limit')
      assert.equal(error.partialCount >= d.MAX_DISCOVERY_ITEMS, true)
      return true
    },
  )
  // The item limit, not the page limit, is what stopped it.
  assert.equal(calls < d.MAX_DISCOVERY_PAGES, true)
})

test('a truncated listing cannot replace a complete catalog', async () => {
  // F07. Callers publish whatever listAllPages returns as the server's
  // catalog. A partial list returned as a value would cache a truncated
  // subset as complete, and could overwrite a larger complete catalog.
  let mode = 'complete'
  const fetch = d.memoizeDiscovery(
    async () => {
      if (mode === 'complete') return ['a', 'b', 'c']
      return d.listAllPages('fixture', 'tools/list', async () => ({
        items: ['a'],
        nextCursor: 'same',
      }))
    },
    () => 'server',
    10,
  )
  assert.deepEqual(await fetch(), ['a', 'b', 'c'])

  mode = 'truncated'
  fetch.cache.delete('server')
  // The incomplete refresh throws, so the last complete catalog stands.
  assert.deepEqual(await fetch(), ['a', 'b', 'c'])
})

test('a failed later page rejects rather than returning a partial catalog', async () => {
  // A partial list returned as if complete would silently drop tools. The
  // caller decides whether to keep a previous good catalog instead.
  let calls = 0
  await assert.rejects(
    d.listAllPages('fixture', 'tools/list', async () => {
      calls++
      if (calls === 1) return { items: ['a'], nextCursor: 'next' }
      throw new Error('page two failed')
    }),
    /page two failed/,
  )
})

test('the discovery cache serves a cached success without refetching', async () => {
  let calls = 0
  const fetch = d.memoizeDiscovery(
    async () => {
      calls++
      return ['tool']
    },
    () => 'server',
    10,
  )
  assert.deepEqual(await fetch(), ['tool'])
  assert.deepEqual(await fetch(), ['tool'])
  assert.equal(calls, 1)
})

test('concurrent callers share one in-flight discovery', async () => {
  let calls = 0
  const fetch = d.memoizeDiscovery(
    async () => {
      calls++
      await new Promise(r => setTimeout(r, 30))
      return ['tool']
    },
    () => 'server',
    10,
  )
  const [a, b, c] = await Promise.all([fetch(), fetch(), fetch()])
  assert.deepEqual(a, ['tool'])
  assert.deepEqual(b, ['tool'])
  assert.deepEqual(c, ['tool'])
  assert.equal(calls, 1)
})

test('a failure is not cached as an empty catalog', async () => {
  // The defect this replaces: the fetcher swallowed its error and returned
  // [], which memoizeWithLRU then cached as "this server has no tools".
  let calls = 0
  const fetch = d.memoizeDiscovery(
    async () => {
      calls++
      if (calls === 1) throw new Error('transient')
      return ['tool']
    },
    () => 'server',
    10,
  )
  await assert.rejects(fetch(), /transient/)
  // The next call retries instead of serving a memoized empty list.
  assert.deepEqual(await fetch(), ['tool'])
  assert.equal(calls, 2)
})

test('a failed refresh falls back to the last successful catalog', async () => {
  // delete() marks the entry stale rather than discarding it, so a refetch
  // that fails still has the previous complete catalog to serve. Otherwise
  // every failed refresh would look like a server whose tools vanished.
  let mode = 'ok'
  let calls = 0
  const fetch = d.memoizeDiscovery(
    async () => {
      calls++
      if (mode === 'fail') throw new Error('server restarting')
      return ['tool-a', 'tool-b']
    },
    () => 'server',
    10,
  )
  assert.deepEqual(await fetch(), ['tool-a', 'tool-b'])
  fetch.cache.delete('server')
  mode = 'fail'
  assert.deepEqual(await fetch(), ['tool-a', 'tool-b'])
  assert.equal(calls, 2)

  // Still stale, so a later call tries again instead of settling for it.
  mode = 'ok'
  assert.deepEqual(await fetch(), ['tool-a', 'tool-b'])
  assert.equal(calls, 3)
})

test('a successful refresh replaces the catalog and stops refetching', async () => {
  let tools = ['old']
  let calls = 0
  const fetch = d.memoizeDiscovery(
    async () => {
      calls++
      return tools
    },
    () => 'server',
    10,
  )
  assert.deepEqual(await fetch(), ['old'])
  fetch.cache.delete('server')
  tools = ['new']
  assert.deepEqual(await fetch(), ['new'])
  // Fresh again: no further fetch.
  assert.deepEqual(await fetch(), ['new'])
  assert.equal(calls, 2)
})

test('discard leaves nothing to fall back to', async () => {
  // For a server being disposed: its catalog is no longer ours to serve.
  let mode = 'ok'
  const fetch = d.memoizeDiscovery(
    async () => {
      if (mode === 'fail') throw new Error('gone')
      return ['tool']
    },
    () => 'server',
    10,
  )
  assert.deepEqual(await fetch(), ['tool'])
  assert.equal(fetch.cache.discard('server'), true)
  assert.equal(fetch.cache.get('server'), undefined)
  mode = 'fail'
  await assert.rejects(fetch(), /gone/)
})

test('a synchronously thrown fetch does not strand the in-flight entry', async () => {
  let calls = 0
  const fetch = d.memoizeDiscovery(
    // Not async: this throws before returning a promise at all.
    () => {
      calls++
      if (calls === 1) throw new Error('bad config')
      return Promise.resolve(['tool'])
    },
    () => 'server',
    10,
  )
  await assert.rejects(fetch(), /bad config/)
  // If the failed operation were still registered as in flight, this would
  // hang on it forever instead of retrying.
  assert.deepEqual(await fetch(), ['tool'])
})

test('the cache is bounded and evicts the least recently succeeded key', async () => {
  const seen = []
  const fetch = d.memoizeDiscovery(
    async key => {
      seen.push(key)
      return [key]
    },
    key => key,
    2,
  )
  await fetch('a')
  await fetch('b')
  await fetch('c')
  // 'a' was evicted, so asking for it fetches again.
  await fetch('a')
  assert.deepEqual(seen, ['a', 'b', 'c', 'a'])
  // 'c' is still cached.
  await fetch('c')
  assert.deepEqual(seen, ['a', 'b', 'c', 'a'])
})

test('cache.get exposes the last successful value, and delete clears it', async () => {
  const fetch = d.memoizeDiscovery(
    async () => ['tool'],
    () => 'server',
    10,
  )
  assert.equal(fetch.cache.get('server'), undefined)
  await fetch()
  assert.deepEqual(fetch.cache.get('server'), ['tool'])
  // delete() marks stale but keeps the value reachable as a fallback;
  // discard() is the one that removes it.
  assert.equal(fetch.cache.delete('server'), true)
  assert.deepEqual(fetch.cache.get('server'), ['tool'])
  assert.equal(fetch.cache.discard('server'), true)
  assert.equal(fetch.cache.get('server'), undefined)
})

test('different keys do not share a catalog', async () => {
  const fetch = d.memoizeDiscovery(
    async key => [`${key}-tool`],
    key => key,
    10,
  )
  assert.deepEqual(await fetch('alpha'), ['alpha-tool'])
  assert.deepEqual(await fetch('beta'), ['beta-tool'])
  assert.deepEqual(await fetch('alpha'), ['alpha-tool'])
})

test('concurrent waiters on a failing refresh all get the same outcome', async () => {
  // F03. The fallback used to be applied by each caller after awaiting the
  // shared operation, so the first waiter received the last-good catalog
  // while the others received the raw rejection. One caller could then
  // dispose a connection while another published success from the same
  // refresh.
  let mode = 'ok'
  const fetch = d.memoizeDiscovery(
    async () => {
      if (mode === 'fail') {
        await new Promise(r => setTimeout(r, 20))
        throw new Error('boom')
      }
      return ['tool']
    },
    () => 'server',
    10,
  )
  await fetch()
  fetch.cache.delete('server')
  mode = 'fail'

  const settled = await Promise.allSettled([fetch(), fetch(), fetch()])
  assert.deepEqual(
    settled.map(r => r.status),
    ['fulfilled', 'fulfilled', 'fulfilled'],
  )
  for (const result of settled) {
    assert.deepEqual(result.value, ['tool'])
  }
})

test('concurrent waiters with nothing known-good all see the failure', async () => {
  // The same agreement in the other direction: with no previous catalog to
  // fall back to, every waiter must see the rejection rather than one of
  // them receiving an empty success.
  const fetch = d.memoizeDiscovery(
    async () => {
      await new Promise(r => setTimeout(r, 20))
      throw new Error('cold failure')
    },
    () => 'server',
    10,
  )
  const settled = await Promise.allSettled([fetch(), fetch(), fetch()])
  assert.deepEqual(
    settled.map(r => r.status),
    ['rejected', 'rejected', 'rejected'],
  )
})
