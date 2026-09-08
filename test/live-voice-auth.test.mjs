import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
const bundle = await build({
  stdin: { contents: `export { getValidOpenAISessionAccess } from ${JSON.stringify(resolve('src/services/api/auth/openai_oauth.ts'))}; export { state } from 'test:keys';`, resolveDir: process.cwd() },
  bundle: true, write: false, packages: 'external', format: 'cjs', platform: 'node', target: 'node20',
  plugins: [{ name: 'isolated-credentials', setup(builder) {
    builder.onResolve({ filter: /(?:api_key_manager\.js|test:keys)$/ }, () => ({ path: 'keys', namespace: 'test' }))
    builder.onResolve({ filter: /utils\/browser\.js$/ }, () => ({ path: 'browser', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'keys'
      ? `export const state = { value: null, writes: [] }; export function loadProviderKey() { return state.value }; export function saveProviderKey(provider, value) { state.writes.push({provider, value}); state.value = value }`
      : `export const openBrowser = async () => { throw new Error('Browser must not open in these tests') }` }))
  } }],
})
const calls = []
let respond = async () => { throw new Error('Unexpected network request') }
const module = { exports: {} }
new Function('require', 'module', 'exports', 'fetch', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports, async (...args) => { calls.push(args); return respond(...args) })
const { getValidOpenAISessionAccess: access, state } = module.exports
const jwt = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })).toString('base64url')}.signature`
function reset(patch = {}) {
  state.value = JSON.stringify({ accessToken: 'api-key-must-not-be-used', sessionToken: jwt, refreshToken: 'refresh-test', expiresAt: Date.now() + 3_600_000, ...patch })
  state.writes = []
  calls.length = 0
  respond = async () => { throw new Error('Unexpected network request') }
}
const response = body => ({ ok: true, json: async () => body })
test('fresh voice auth returns the session token/account, never the API key', async () => {
  reset()
  assert.deepEqual(await access(), { accessToken: jwt, accountId: 'account-1' })
  assert.equal(calls.length, 0)
  assert.equal(state.writes.length, 0)
})
test('missing, malformed and null credentials consistently show the login hint', async () => {
  for (const value of [null, '{', 'null', '[]', '\"string\"', '{}', JSON.stringify({ expiresAt: Date.now() + 1000000, sessionToken: 42 })]) {
    reset()
    state.value = value
    await assert.rejects(access(), error => !(error instanceof TypeError) && /\/login openai/.test(error.message))
    assert.equal(calls.length, 0)
  }
})
test('expired sessions refresh once with bounded fetch and use first-exchange session credentials', async () => {
  reset({ expiresAt: 0 })
  respond = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.body.get('refresh_token'), 'refresh-test')
    return response({ access_token: 'new-session', refresh_token: 'new-refresh', expires_in: 3600 })
  }
  assert.deepEqual(await access(), { accessToken: 'new-session' })
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(state.value).refreshToken, 'new-refresh')
})
test('forced refresh shares a single request between concurrent voice callers', async () => {
  reset()
  let release
  respond = () => new Promise(resolve => { release = resolve })
  const first = access(true)
  const second = access(true)
  assert.equal(calls.length, 1)
  release(response({ access_token: 'fresh', expires_in: 3600 }))
  assert.deepEqual(await Promise.all([first, second]), [{ accessToken: 'fresh' }, { accessToken: 'fresh' }])
})
test('/bye cancels its wait immediately without cancelling another shared refresh caller', async () => {
  reset({ expiresAt: 0 })
  let release
  respond = () => new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const first = access(false, controller.signal)
  const second = access()
  const rejected = assert.rejects(first, /Voice stopped/)
  controller.abort(new DOMException('Voice stopped', 'AbortError'))
  await rejected
  release(response({ access_token: 'fresh-after-stop', expires_in: 3600 }))
  assert.deepEqual(await second, { accessToken: 'fresh-after-stop' })
  assert.equal(calls.length, 1)
})
test('invalid refresh payload cannot overwrite saved credentials', async () => {
  reset({ expiresAt: 0 })
  const before = state.value
  respond = async () => response({ access_token: null, expires_in: 3600 })
  await assert.rejects(access(), /could not be refreshed/)
  assert.equal(state.value, before)
  assert.equal(state.writes.length, 0)
})
