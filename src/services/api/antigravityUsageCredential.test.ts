/** Run: bun test src/services/api/antigravityUsageCredential.test.ts */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(os.tmpdir(), 'tau-antigravity-usage-'))
mock.module('os', () => ({ ...os, homedir: () => testHome }))
// Isolate the unrelated providers' application/auth dependencies; the Google
// credential store, refresh reader, discovery, and quota path remain real.
mock.module('../../utils/auth.js', () => ({
  getClaudeAIOAuthTokens: () => null,
  getProviderBaseUrl: () => null,
  getProviderApiKey: () => null,
  getSubscriptionType: () => null,
}))
mock.module('../../utils/model/providers.js', () => ({
  PROVIDER_DISPLAY_NAMES: { antigravity: 'Antigravity' },
}))
mock.module('./usage.js', () => ({ fetchUtilization: async () => null }))
const { saveProviderKey, deleteProviderKey } = await import('./auth/api_key_manager.js')
const { saveStore } = await import('../../lanes/shared/antigravity_auth.js')
const { clearCodeAssistCache, ensureCodeAssistReady } = await import('./providers/gemini_code_assist.js')
const { fetchProviderUsageFor } = await import('./providerUsage.js')
const originalFetch = globalThis.fetch
const quotaCalls: Array<{ url: string; token: string; body: Record<string, unknown> }> = []
let rejectDiscovery = false
let rejectScopedQuota = false
let oldAccountQuotaAttempts = 0

function oauth(accessToken: string, expiresAt = Date.now() + 3_600_000): void {
  saveProviderKey('gemini_oauth_antigravity', JSON.stringify({ accessToken, expiresAt }))
}

function legacyAccount(email: string, accessToken: string, enabled = true) {
  return {
    email, accessToken, refreshToken: 'legacy-refresh',
    expires: Date.now() + 3_600_000, projectId: 'obsolete-stored-project',
    addedAt: 0, lastUsed: 0, enabled, rateLimitResetTimes: {},
  }
}

beforeEach(() => {
  clearCodeAssistCache('antigravity')
  deleteProviderKey('gemini_oauth_antigravity')
  saveStore({ version: 1, accounts: [], activeIndex: 0, activeIndexByFamily: {} })
  quotaCalls.length = 0
  rejectDiscovery = false
  rejectScopedQuota = false
  oldAccountQuotaAttempts = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? ''
    if (url.endsWith(':loadCodeAssist')) {
      return rejectDiscovery
        ? new Response('not available', { status: 403 })
        : Response.json({ cloudaicompanionProject: `project-${token}` })
    }
    if (url.endsWith(':retrieveUserQuota')) return Response.json({ buckets: [] })
    if (url.endsWith('/oauth2/v2/userinfo')) return Response.json({ email: `${token}@example.com` })
    if (url.endsWith(':fetchAvailableModels')) {
      const body = JSON.parse(String(init?.body))
      quotaCalls.push({ url, token, body })
      if (token === 'old-fallback' && ++oldAccountQuotaAttempts === 1) {
        return new Response('quota unavailable', { status: 403 })
      }
      if (rejectScopedQuota && body.project) return new Response('quota unavailable', { status: 403 })
      return Response.json({ models: {
        'gemini-3-flash-agent': { displayName: 'Gemini 3.5 Flash (High)', quotaInfo: { remainingFraction: token === 'current' ? 0.25 : 0.95 } },
        'gemini-3.5-flash-low': { displayName: 'Gemini 3.5 Flash (Medium)', quotaInfo: { remainingFraction: token === 'current' ? 0.25 : 0.95 } },
        'gemini-3.5-flash-extra-low': { displayName: 'Gemini 3.5 Flash (Low)', quotaInfo: { remainingFraction: token === 'current' ? 0.25 : 0.95 } },
      } })
    }
    throw new Error(`Unexpected network request: ${url}`)
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
})

test('/usage and status bar use the OAuth login instead of a previous account store', async () => {
  oauth('current')
  saveStore({ version: 1, activeIndex: 0, activeIndexByFamily: {}, accounts: [legacyAccount('old@example.com', 'old')] })
  const usage = await fetchProviderUsageFor('antigravity')
  const status = await fetchProviderUsageFor('antigravity', { statusBar: true })
  expect(usage?.status).toBe('ok')
  expect(usage?.detail).toContain('current@example.com')
  expect(status?.status).toBe('ok')
  expect(usage?.metrics).toEqual(status?.metrics)
  expect(quotaCalls.length).toBeGreaterThan(0)
  expect(quotaCalls.every(call => call.token === 'current' && call.body.project === 'project-current')).toBe(true)
})

test('an expired selected login never falls back to quota from another account', async () => {
  oauth('current', Date.now() - 1000)
  saveStore({ version: 1, activeIndex: 0, activeIndexByFamily: {}, accounts: [legacyAccount('old@example.com', 'old')] })
  expect((await fetchProviderUsageFor('antigravity'))?.status).toBe('error')
  expect((await fetchProviderUsageFor('antigravity', { statusBar: true }))?.status).toBe('error')
  expect(quotaCalls).toEqual([])
})

test('a new login cannot use the old login project in a read-only status fetch', async () => {
  await ensureCodeAssistReady('old', 'antigravity')
  oauth('current')
  expect((await fetchProviderUsageFor('antigravity', { statusBar: true }))?.status).toBe('error')
  expect(quotaCalls).toEqual([])
  expect((await fetchProviderUsageFor('antigravity'))?.status).toBe('ok')
  expect(quotaCalls.every(call => call.token === 'current' && call.body.project === 'project-current')).toBe(true)
})

test('legacy-only usage matches the active account and discovers its project', async () => {
  saveStore({
    version: 1, activeIndex: 0, activeIndexByFamily: { 'gemini-flash': 1 },
    accounts: [legacyAccount('current@example.com', 'current'), legacyAccount('old@example.com', 'old')],
  })
  expect((await fetchProviderUsageFor('antigravity'))?.status).toBe('ok')
  expect((await fetchProviderUsageFor('antigravity', { statusBar: true }))?.status).toBe('ok')
  expect(quotaCalls.every(call => call.token === 'current' && call.body.project === 'project-current')).toBe(true)
})

test('failed project discovery does not request unscoped default quota', async () => {
  oauth('current')
  rejectDiscovery = true
  expect((await fetchProviderUsageFor('antigravity'))?.status).toBe('error')
  expect(quotaCalls).toEqual([])
})

test('failed scoped quota calls never fall back to an unscoped model catalog', async () => {
  oauth('current')
  rejectScopedQuota = true
  const usage = await fetchProviderUsageFor('antigravity')
  expect(usage?.status).not.toBe('ok')
  expect(usage?.metrics).toBeUndefined()
  expect(quotaCalls.length).toBeGreaterThan(0)
  expect(quotaCalls.every(call => call.body.project === 'project-current')).toBe(true)
})

test('a prior login quota fallback host does not change the new login status search', async () => {
  oauth('old-fallback')
  expect((await fetchProviderUsageFor('antigravity'))?.status).toBe('ok')
  expect(quotaCalls.length).toBe(2)
  const primaryUrl = quotaCalls[0]!.url
  oauth('current')
  await ensureCodeAssistReady('current', 'antigravity')
  quotaCalls.length = 0
  expect((await fetchProviderUsageFor('antigravity', { statusBar: true }))?.status).toBe('ok')
  expect(quotaCalls[0]!.url).toBe(primaryUrl)
  expect(quotaCalls[0]!.token).toBe('current')
})
