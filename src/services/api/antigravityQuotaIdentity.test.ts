/** Run: bun test src/services/api/antigravityQuotaIdentity.test.ts */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(os.tmpdir(), 'tau-antigravity-quota-identity-'))
mock.module('os', () => ({ ...os, homedir: () => testHome }))
const pendingReports: Array<(value: any) => void> = []
mock.module('./providerUsage.js', () => ({
  fetchProviderUsageFor: () => new Promise(resolve => pendingReports.push(resolve)),
}))
const { saveProviderKey, deleteProviderKey } = await import('./auth/api_key_manager.js')
const { saveStore } = await import('../../lanes/shared/antigravity_auth.js')
const {
  _noteOutcome, _shouldFetch, ensureProviderQuotaFresh, getProviderQuotaOutcome, resetProviderQuotaCache,
} = await import('./providerQuotaCache.js')

const reading = (usedPercent: number) => ({ kind: 'reading' as const, usedPercent, summary: null, label: 'Gemini' })
const report = (usedPercent: number) => ({ status: 'ok', metrics: [{ label: 'Gemini', usedPercent }] })
function login(account: string, accessToken = `access-${account}`): void {
  saveProviderKey('gemini_oauth_antigravity', JSON.stringify({ accessToken, refreshToken: `refresh-${account}` }))
}
async function flush(): Promise<void> {
  // Let the dynamic import and promise chain finish without a real timer.
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  resetProviderQuotaCache()
  pendingReports.length = 0
  deleteProviderKey('gemini_oauth_antigravity')
  saveStore({ version: 1, accounts: [], activeIndex: 0, activeIndexByFamily: {} })
})
afterAll(() => {
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
})

test('changing Antigravity login immediately hides the old account quota and backoff', () => {
  login('old')
  _noteOutcome('antigravity', reading(99))
  _noteOutcome('antigravity', null)
  expect(getProviderQuotaOutcome('antigravity')).toEqual(reading(99))
  login('current')
  expect(getProviderQuotaOutcome('antigravity')).toBeUndefined()
  expect(_shouldFetch('antigravity', Date.now())).toBe(true)
  _noteOutcome('antigravity', null)
  expect(getProviderQuotaOutcome('antigravity')).toBeUndefined()
})

test('renewing the same account token preserves its reading', () => {
  login('current')
  _noteOutcome('antigravity', reading(25))
  login('current', 'renewed-access')
  expect(getProviderQuotaOutcome('antigravity')).toEqual(reading(25))
})

test('the previous login in flight cannot block or overwrite the new login reading', async () => {
  login('old')
  ensureProviderQuotaFresh('antigravity')
  await flush()
  expect(pendingReports.length).toBe(1)
  login('current')
  ensureProviderQuotaFresh('antigravity')
  await flush()
  expect(pendingReports.length).toBe(2)
  pendingReports[1]!(report(25))
  await flush()
  pendingReports[0]!(report(99))
  await flush()
  expect(getProviderQuotaOutcome('antigravity')?.kind).toBe('reading')
  expect((getProviderQuotaOutcome('antigravity') as any)?.usedPercent).toBe(25)
})

test('other provider readings and backoff are unchanged by Antigravity login', () => {
  _noteOutcome('openrouter', reading(75))
  _noteOutcome('openrouter', null)
  login('current')
  expect(getProviderQuotaOutcome('openrouter')).toEqual(reading(75))
  expect(_shouldFetch('openrouter', Date.now())).toBe(false)
})

test('malformed Antigravity credentials cannot crash a status read', () => {
  saveProviderKey('gemini_oauth_antigravity', JSON.stringify({ refreshToken: { bad: true } }))
  expect(getProviderQuotaOutcome('antigravity')).toBeUndefined()
  expect(_shouldFetch('antigravity', Date.now())).toBe(true)
})
