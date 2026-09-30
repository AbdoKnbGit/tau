import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import axios from 'axios'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const configDirectory = mkdtempSync(join(tmpdir(), 'tau-no-claudeai-'))
process.env.CLAUDE_CONFIG_DIR = configDirectory
process.env.DISABLE_TELEMETRY = '1'
test.after(() => rmSync(configDirectory, { recursive: true, force: true }))

// Run the shipped config pipeline with a signed-in account and configured
// servers. A matching plugin must survive even if the account advertises
// the same service through claude.ai.
const r = await loadMcpRuntime({
  paths: ['src/services/mcp/config.ts', 'src/utils/powerMode.ts'],
  exports: ['getAllMcpConfigs', 'setSessionPowerMode', `installFixtures: fixtures => {
    getClaudeAIOAuthTokens = () => ({ accessToken: 'fixture-only', scopes: ['user:mcp_servers'] });
    doesEnterpriseMcpConfigExist = () => false;
    getMcpConfigsByScope = scope => ({ servers: scope === 'user' ? fixtures.manual : {} });
    loadAllPluginsCacheOnly = async () => ({ enabled: [{ name: 'fixture' }], errors: [] });
    getPluginMcpServers = async () => fixtures.plugin;
  }`],
})

const manual = {
  local: { type: 'stdio', command: process.execPath, args: ['fixture.mjs'], scope: 'user' },
  remote: { type: 'http', url: 'https://fixture.invalid/custom', scope: 'user' },
}
const plugin = {
  'plugin:fixture:gmail': { type: 'http', url: 'https://fixture.invalid/gmail', scope: 'plugin' },
}
r.installFixtures({ manual, plugin })

let accountRequests = 0
const originalGet = axios.get
axios.get = async () => {
  accountRequests++
  return { data: { has_more: false, next_page: null, data: [
    { display_name: 'Claude Docs', id: 'docs', url: 'https://fixture.invalid/docs' },
    { display_name: 'Gmail', id: 'gmail', url: 'https://fixture.invalid/gmail' },
    { display_name: 'Google Calendar', id: 'calendar', url: 'https://fixture.invalid/calendar' },
    { display_name: 'Google Drive', id: 'drive', url: 'https://fixture.invalid/drive' },
  ] } }
}
test.after(() => { axios.get = originalGet })

for (const legacyFlag of [undefined, '0', '1', 'true']) {
  test(`normal mode preserves custom/plugin MCPs without importing account connectors (legacy flag=${legacyFlag})`, async () => {
    if (legacyFlag === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS
    else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = legacyFlag
    r.setSessionPowerMode('normal')
    const result = await r.getAllMcpConfigs()
    assert.deepEqual(result.servers, { ...plugin, ...manual })
    assert.deepEqual(result.errors, [])
    assert.equal(accountRequests, 0, 'MCP discovery contacted the claude.ai account')
  })
}

test('cheap mode still returns no MCP servers', async () => {
  r.setSessionPowerMode('cheap')
  assert.deepEqual(await r.getAllMcpConfigs(), { servers: {}, errors: [] })
  assert.equal(accountRequests, 0)
})

test('returning to normal mode restores configured servers only', async () => {
  r.setSessionPowerMode('normal')
  assert.deepEqual((await r.getAllMcpConfigs()).servers, { ...plugin, ...manual })
  assert.equal(accountRequests, 0)
})
