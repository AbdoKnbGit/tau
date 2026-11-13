/** Run: bun test ./src/services/api/providers/antigravity_project_cache.test.ts */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ANTIGRAVITY_HUB_USER_AGENT } from '../../../constants/antigravity.js'

const testHome = mkdtempSync(join(os.tmpdir(), 'tau-antigravity-project-'))
mock.module('os', () => ({ ...os, homedir: () => testHome }))
const {
  clearCodeAssistCache,
  ensureCodeAssistReady,
  peekCodeAssistProject,
  describeAntigravityEntitlementGap,
} = await import('./gemini_code_assist.js')
const cacheDir = join(testHome, '.config', 'claude-code')
const cacheFile = join(cacheDir, 'gemini-code-assist.json')
const originalFetch = globalThis.fetch
const originalProject = process.env.GOOGLE_CLOUD_PROJECT
const originalGeminiProject = process.env.GEMINI_CLOUD_PROJECT
const loads: string[] = []

beforeEach(() => {
  clearCodeAssistCache()
  loads.length = 0
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.GEMINI_CLOUD_PROJECT
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
    if (url.endsWith(':loadCodeAssist')) {
      loads.push(token)
      return Response.json({ cloudaicompanionProject: `project-${token}` })
    }
    if (url.endsWith(':retrieveUserQuota')) return Response.json({ buckets: [] })
    throw new Error(`Unexpected network call: ${url}`)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT
  else process.env.GOOGLE_CLOUD_PROJECT = originalProject
  if (originalGeminiProject === undefined) delete process.env.GEMINI_CLOUD_PROJECT
  else process.env.GEMINI_CLOUD_PROJECT = originalGeminiProject
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
})

test('an ownerless legacy project is rediscovered using the request credential', async () => {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({
    version: 7, projectId: 'previous-account-project', onboardedAt: Date.now(),
    entitledModelIds: ['another-account-model'],
  }))
  expect(describeAntigravityEntitlementGap('gemini-3.7-flash-low')).toBeNull()
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
  expect(loads).toEqual(['account-A'])
})

test.each([undefined, 'antigravity/hub/2.8.1 darwin/arm64', 'antigravity/hub/2.23.0 darwin/arm64'])(
  'discovery from an old Hub identity (%s) is refreshed once', async userAgent => {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile, JSON.stringify({
      version: 7, credentialKey: createHash('sha256').update('account-A').digest('hex'),
      userAgent, projectId: 'stale-project', onboardedAt: Date.now(),
      entitledModelIds: ['gemini-3.8-flash-tiered'],
    }))
    expect(peekCodeAssistProject('antigravity', 'account-A')).toBeNull()
    expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
    expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
    expect(loads).toEqual(['account-A'])
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).userAgent).toBe(ANTIGRAVITY_HUB_USER_AGENT)
    expect(describeAntigravityEntitlementGap('gemini-4-argon-high')).toBeNull()
  },
)

test('matching Hub and credential reuse disk discovery without a network call', async () => {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({
    version: 7, credentialKey: createHash('sha256').update('account-A').digest('hex'),
    userAgent: ANTIGRAVITY_HUB_USER_AGENT, projectId: 'saved-project', onboardedAt: Date.now(),
    entitledModelIds: ['gemini-4-argon-high'],
  }))
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('saved-project')
  expect(loads).toEqual([])
  for (const level of ['low', 'medium', 'high']) {
    expect(describeAntigravityEntitlementGap(`gemini-4-argon-${level}`)).toBeNull()
  }
  expect(describeAntigravityEntitlementGap('gemini-3.8-flash-low')).toContain('gemini-3.8-flash-low')
})

test('one listed level names every level of its Gemini 4 model as usable', async () => {
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cacheFile, JSON.stringify({
    version: 7, credentialKey: createHash('sha256').update('account-A').digest('hex'),
    userAgent: ANTIGRAVITY_HUB_USER_AGENT, projectId: 'saved-project', onboardedAt: Date.now(),
    entitledModelIds: ['gemini-4-carbon-high', 'gemini-4-hydrogen-xhigh'],
  }))
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('saved-project')
  const listed = ['carbon', 'hydrogen'].flatMap(family =>
    ['low', 'medium', 'high'].map(level => `gemini-4-${family}-${level}`))
  const gap = describeAntigravityEntitlementGap('gemini-3.8-flash-low')
  expect(gap).toContain('not entitled to gemini-3.8-flash-low')
  for (const model of listed) expect(gap).toContain(model)
  expect(gap).not.toContain('gemini-4-argon')
})

test('Gemini 4 entitlement follows the account plan, never the production quota list', async () => {
  // Production's quota list leaves every Gemini 4 id out, even for plans that
  // include them, as on the real Pro account this list is copied from.
  const fetchNow = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('authorization')!.replace('Bearer ', '')
    if (url.endsWith(':loadCodeAssist')) {
      const paid = ({
        'pro-account': 'g1-pro-tier', 'ultra-account': 'g1-ultra-tier', 'ultra-lite-account': 'g1-ultra-lite-tier',
        'starter-account': 'free-tier',
      } as Record<string, string>)[token]
      return Response.json({
        cloudaicompanionProject: `project-${token}`,
        ...(token === 'business-account' ? { currentTier: { id: 'standard-tier' } } : {}),
        ...(paid ? { currentTier: { id: 'free-tier' }, paidTier: { id: paid } } : {}),
      })
    }
    if (url.endsWith(':retrieveUserQuota')) {
      return Response.json({ buckets: ['claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gemini-3-flash',
        'gemini-3.8-flash-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-tiered']
        .map(modelId => ({ modelId })) })
    }
    return fetchNow(input, init)
  }) as typeof fetch

  const levels = (family: string) => ['low', 'medium', 'high'].map(level => `gemini-4-${family}-${level}`)
  for (const account of ['pro-account', 'ultra-account', 'ultra-lite-account', 'business-account', 'unknown-plan-account', 'starter-account']) {
    await ensureCodeAssistReady(account, 'antigravity')
    // A 429 on these is throttling, never "not entitled", on every plan.
    for (const model of [...levels('argon'), ...levels('hydrogen')]) {
      expect(describeAntigravityEntitlementGap(model)).toBeNull()
    }
    for (const model of levels('carbon')) {
      const gap = describeAntigravityEntitlementGap(model)
      if (account === 'pro-account') {
        expect(gap).toContain('Gemini 4 Carbon on Antigravity launched for Google AI Ultra and business plans')
        expect(gap).toContain('the "g1-pro-tier" plan')
        expect(gap).not.toContain('not entitled')
      } else if (account === 'starter-account') {
        expect(gap).toContain('the free plan')
      } else {
        expect(gap).toBeNull()
      }
    }
  }
})

test('entitlement diagnostics follow the request credential instead of another login', async () => {
  const fetchNow = globalThis.fetch
  const argonModels = ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high']
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith(':retrieveUserQuota')) {
      const token = new Headers(init?.headers).get('authorization')
      // 3.7 and Argon use per-level ids; 3.8 still shares a tiered wire id.
      const models = token === 'Bearer account-A'
        ? ['gemini-3.7-flash-low', ...argonModels] : ['gemini-3.8-flash-tiered']
      return Response.json({ buckets: models.map(modelId => ({ modelId })) })
    }
    return fetchNow(input, init)
  }) as typeof fetch
  await ensureCodeAssistReady('account-A', 'antigravity')
  expect(describeAntigravityEntitlementGap('gemini-3.7-flash-low')).toBeNull()
  const gap = describeAntigravityEntitlementGap('gemini-3.8-flash-low')
  expect(gap).toContain('gemini-3.8-flash-low')
  expect(gap).not.toContain('gemini-3.7-flash-low') // retired suggestions stay hidden
  for (const model of argonModels) {
    expect(describeAntigravityEntitlementGap(model)).toBeNull()
    expect(gap).toContain(model)
  }
  await ensureCodeAssistReady('account-B', 'antigravity')
  expect(describeAntigravityEntitlementGap('gemini-3.8-flash-low')).toBeNull()
  expect(describeAntigravityEntitlementGap('gemini-3.7-flash-low')).toContain('gemini-3.7-flash-low')
  // Production's list leaves Gemini 4 out even where the plan includes it, so
  // its absence from account B's list is no claim against Argon.
  for (const model of argonModels) {
    expect(describeAntigravityEntitlementGap(model)).toBeNull()
  }
})

test('Claude 5.5 entitlement follows the account plan, not the production quota list', async () => {
  // Production's quota list omits the Claude 5.5 ids even on Pro accounts
  // (only the daily host lists them), so a missing bucket proves nothing.
  const fetchNow = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('authorization')
    if (url.endsWith(':loadCodeAssist')) {
      return Response.json({
        cloudaicompanionProject: `project-${token}`,
        currentTier: { id: 'free-tier' },
        paidTier: token === 'Bearer pro-account'
          ? { id: 'g1-pro-tier', name: 'Google AI Pro' }
          : { id: 'free-tier', name: 'Antigravity Starter Quota' },
      })
    }
    if (url.endsWith(':retrieveUserQuota')) {
      return Response.json({ buckets: [{ modelId: 'claude-opus-4-6-thinking' }] })
    }
    return fetchNow(input, init)
  }) as typeof fetch

  await ensureCodeAssistReady('pro-account', 'antigravity')
  expect(describeAntigravityEntitlementGap('claude-opus-5-5-high')).toBeNull()
  expect(describeAntigravityEntitlementGap('claude-sonnet-5-5-low')).toBeNull()

  await ensureCodeAssistReady('starter-account', 'antigravity')
  const gap = describeAntigravityEntitlementGap('claude-opus-5-5-medium')
  expect(gap).toContain('Claude Opus 5.5')
  expect(gap).toContain('Pro and Ultra')
  expect(gap).toContain('the free plan')
})

test('switching credentials never pairs the new token with the old project', async () => {
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
  expect(await ensureCodeAssistReady('account-B', 'antigravity')).toBe('project-account-B')
  expect(await ensureCodeAssistReady('account-B', 'antigravity')).toBe('project-account-B')
  expect(loads).toEqual(['account-A', 'account-B'])
  expect(readFileSync(cacheFile, 'utf8')).not.toContain('"account-B"')
  expect(peekCodeAssistProject('antigravity', 'account-B')).toBe('project-account-B')
  expect(peekCodeAssistProject('antigravity', 'account-A')).toBeNull()
})

test('concurrent warmup and request share one discovery for the same credential', async () => {
  expect(await Promise.all([
    ensureCodeAssistReady('account-A', 'antigravity'),
    ensureCodeAssistReady('account-A', 'antigravity'),
  ])).toEqual(['project-account-A', 'project-account-A'])
  expect(loads).toEqual(['account-A'])
})

test('a previous account warmup cannot overwrite the newly selected account cache', async () => {
  const fetchNow = globalThis.fetch
  let finishOld!: (response: Response) => void
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith(':loadCodeAssist')
      && new Headers(init?.headers).get('authorization') === 'Bearer account-A') {
      return new Promise<Response>(resolve => { finishOld = resolve })
    }
    return fetchNow(input, init)
  }) as typeof fetch
  const oldWarmup = ensureCodeAssistReady('account-A', 'antigravity')
  expect(await ensureCodeAssistReady('account-B', 'antigravity')).toBe('project-account-B')
  finishOld(Response.json({ cloudaicompanionProject: 'project-account-A' }))
  expect(await oldWarmup).toBe('project-account-A')
  expect(peekCodeAssistProject('antigravity')).toBe('project-account-B')
  expect(JSON.parse(readFileSync(cacheFile, 'utf8')).projectId).toBe('project-account-B')
})

test('clearing the cache invalidates an in-flight warmup', async () => {
  const fetchNow = globalThis.fetch
  let finishOld!: (response: Response) => void
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith(':loadCodeAssist')) {
      return new Promise<Response>(resolve => { finishOld = resolve })
    }
    return fetchNow(input, init)
  }) as typeof fetch
  const oldWarmup = ensureCodeAssistReady('account-A', 'antigravity')
  clearCodeAssistCache('antigravity')
  finishOld(Response.json({ cloudaicompanionProject: 'old-project' }))
  await oldWarmup
  expect(peekCodeAssistProject('antigravity', 'account-A')).toBeNull()
  globalThis.fetch = fetchNow
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
})

test('Antigravity discovers its managed project despite Gemini Cloud overrides', async () => {
  process.env.GOOGLE_CLOUD_PROJECT = 'unrelated-cloud-project'
  process.env.GEMINI_CLOUD_PROJECT = 'unrelated-gemini-project'
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
})

test('Gemini CLI retains its explicit project override and executor cache', async () => {
  process.env.GEMINI_CLOUD_PROJECT = 'cli-project'
  expect(await ensureCodeAssistReady('cli-token', 'cli')).toBe('cli-project')
  expect(await ensureCodeAssistReady('account-A', 'antigravity')).toBe('project-account-A')
  expect(peekCodeAssistProject('cli')).toBe('cli-project')
})
