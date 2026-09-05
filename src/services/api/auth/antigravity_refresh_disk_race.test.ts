/** Run separately: bun test src/services/api/auth/antigravity_refresh_disk_race.test.ts */

import { afterAll, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(os.tmpdir(), 'tau-antigravity-refresh-disk-'))
mock.module('os', () => ({ ...os, homedir: () => testHome }))

const { refreshGeminiOAuth } = await import('./google_oauth.js')

const configDir = join(testHome, '.config', 'claude-code')
const keyFile = join(configDir, 'provider-keys.json')
const storageKey = 'gemini_oauth_antigravity'
const originalFetch = globalThis.fetch
let finish!: (response: Response) => void
mkdirSync(configDir, { recursive: true })

const credential = (account: string) => ({
  accessToken: `access-${account}`,
  refreshToken: `refresh-${account}`,
  expiresAt: Date.now() + 3_600_000,
})

function writeStore(value: Record<string, unknown>): void {
  writeFileSync(keyFile, JSON.stringify({ version: 1, keys: value, metadata: {} }))
}

function startRefresh(): Promise<string> {
  globalThis.fetch = (() => new Promise<Response>(resolve => {
    finish = resolve
  })) as typeof fetch
  return refreshGeminiOAuth('antigravity', 'refresh-A')
}

test('a login changed in another process is observed before refresh save', async () => {
  writeStore({ [storageKey]: JSON.stringify(credential('A')) })
  const pending = startRefresh()
  const newer = {
    [storageKey]: JSON.stringify(credential('B')),
    openai: 'unrelated-provider-key',
  }
  writeStore(newer)
  finish(Response.json({ access_token: 'refreshed-A', expires_in: 3600 }))

  expect(await pending).toBe('access-B')
  expect(JSON.parse(readFileSync(keyFile, 'utf8')).keys).toEqual(newer)
})

test('a logout changed in another process cannot be undone', async () => {
  writeStore({ [storageKey]: JSON.stringify(credential('A')) })
  const pending = startRefresh()
  writeStore({})
  finish(Response.json({ access_token: 'refreshed-A', expires_in: 3600 }))

  await expect(pending).rejects.toThrow(/Antigravity.*changed/)
  expect(JSON.parse(readFileSync(keyFile, 'utf8')).keys).toEqual({})
})

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  rmSync(testHome, { recursive: true, force: true })
})
