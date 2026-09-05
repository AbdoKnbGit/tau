/** Run: bun test src/services/api/providers/antigravity_project_cache.test.ts */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

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

test('entitlement diagnostics follow the request credential instead of another login', async () => {
  const fetchNow = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith(':retrieveUserQuota')) {
      const token = new Headers(init?.headers).get('authorization')
      return Response.json({ buckets: [{ modelId: token === 'Bearer account-A'
        ? 'gemini-3.7-flash-tiered' : 'gemini-3.8-flash-tiered' }] })
    }
    return fetchNow(input, init)
  }) as typeof fetch
  await ensureCodeAssistReady('account-A', 'antigravity')
  expect(describeAntigravityEntitlementGap('gemini-3.7-flash-low')).toBeNull()
  expect(describeAntigravityEntitlementGap('gemini-3.8-flash-low')).toContain('gemini-3.8-flash-low')
  await ensureCodeAssistReady('account-B', 'antigravity')
  expect(describeAntigravityEntitlementGap('gemini-3.8-flash-low')).toBeNull()
  expect(describeAntigravityEntitlementGap('gemini-3.7-flash-low')).toContain('gemini-3.7-flash-low')
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
