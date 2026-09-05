/** Run: bun test src/services/api/auth/antigravity_refresh_race.test.ts */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'

const credentials = new Map<string, string>()
const saves: string[] = []
let reloads = 0
mock.module('./api_key_manager.js', () => ({
  loadProviderKey: (key: string) => credentials.get(key) ?? null,
  saveProviderKey: (key: string, value: string) => {
    saves.push(key)
    credentials.set(key, value)
  },
}))
mock.module('../providers/providerShim.js', () => ({
  reloadGeminiLaneAuth: async () => { reloads++ },
}))
const { refreshGeminiOAuth } = await import('./google_oauth.js')
const originalFetch = globalThis.fetch
const key = 'gemini_oauth_antigravity'
const blob = (account: string) => JSON.stringify({
  accessToken: `access-${account}`, refreshToken: `refresh-${account}`,
  expiresAt: Date.now() + 3_600_000,
})
let finishRefresh!: (response: Response) => void
beforeEach(() => {
  credentials.clear()
  saves.length = 0
  reloads = 0
  globalThis.fetch = (() => new Promise<Response>(resolve => {
    finishRefresh = resolve
  })) as typeof fetch
})
afterAll(() => { globalThis.fetch = originalFetch; mock.restore() })
function completeRefresh() {
  finishRefresh(Response.json({ access_token: 'refreshed-A', expires_in: 3600 }))
}

test('an old Antigravity refresh cannot replace a newer login', async () => {
  credentials.set(key, blob('A'))
  const pending = refreshGeminiOAuth('antigravity', 'refresh-A')
  const newerLogin = blob('B')
  credentials.set(key, newerLogin)
  completeRefresh()
  expect(await pending).toBe('access-B')
  expect(credentials.get(key)).toBe(newerLogin)
  expect(saves).toEqual([])
  expect(reloads).toBe(0)
})

test('an in-flight Antigravity refresh cannot undo logout', async () => {
  credentials.set(key, blob('A'))
  const pending = refreshGeminiOAuth('antigravity', 'refresh-A')
  credentials.delete(key)
  completeRefresh()
  await expect(pending).rejects.toThrow(/Antigravity.*changed/)
  expect(credentials.has(key)).toBe(false)
  expect(saves).toEqual([])
})

test('normal Antigravity refresh persists the token and reloads once', async () => {
  credentials.set(key, blob('A'))
  const pending = refreshGeminiOAuth('antigravity', 'refresh-A')
  completeRefresh()
  expect(await pending).toBe('refreshed-A')
  expect(JSON.parse(credentials.get(key)!).refreshToken).toBe('refresh-A')
  expect(saves).toEqual([key])
  expect(reloads).toBe(1)
})
