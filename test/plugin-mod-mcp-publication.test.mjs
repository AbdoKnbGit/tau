import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const original = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tau MCP publication é '))
const project = join(root, 'workspace')
const write = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
  CLAUDE_CODE_PLUGIN_DIRS: '',
  CLAUDE_CODE_SIMPLE: '0',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  TAU_MCP_TEST_BUNDLE: resolve(
    process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs',
  ),
})
process.chdir(project)
const r = await loadMcpRuntime({
  paths: ['src/utils/plugins/mods/mcpApi.ts', 'src/services/mcp/readiness.ts'],
  exports: [
    'setInlinePlugins',
    'clearAllCaches',
    'resetSettingsCache',
    'setOriginalCwd',
    'setSessionTrustAccepted',
    'setAllowedSettingSources',
    'setIsInteractive',
    'getManagedFilePath',
    'setModMcpSessionOptions',
    'registerModMcpPublisher',
    'runModMcpAPI',
    'loadAllPluginsCacheOnly',
    'getPluginMcpServers',
    'applyModMcpUpdate',
    'isMcpDiscoverySettled',
    'isMcpServerPublishing',
    'acknowledgeMcpPublication',
    'forgetMcpServer',
  ],
})
r.getManagedFilePath.cache.set(undefined, join(root, 'managed'))
r.setOriginalCwd(project)
r.setSessionTrustAccepted(true, true)
r.setAllowedSettingSources(['projectSettings', 'localSettings'])
r.setIsInteractive(false)
r.setModMcpSessionOptions({ strict: false, dynamic: {} })

after(() => {
  r.setInlinePlugins([])
  process.chdir(original)
  assert.equal(dirname(root), tmpdir())
  assert.ok(root.startsWith(join(tmpdir(), 'tau MCP publication é ')))
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

async function until(predicate) {
  const deadline = Date.now() + 10000
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      'Timed out waiting for publication evidence',
    )
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture() {
  const name = 'publication-' + randomUUID()
  const directory = join(root, name)
  const script = join(directory, 'server with spaces é.mjs')
  const entered = join(directory, 'prompts-entered')
  const released = join(directory, 'prompts-released')
  write(
    script,
    `
    import {createInterface} from 'node:readline';
    import {existsSync,writeFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
      if(q.method==='initialize')return reply({protocolVersion:q.params.protocolVersion,serverInfo:{name:'catalog',version:'1'},capabilities:{tools:{},prompts:{}}});
      if(q.method==='tools/list')return reply({tools:[{name:'inspect',description:'Inspect a shipment',inputSchema:{type:'object'}}]});
      if(q.method==='prompts/list'){
        writeFileSync(process.argv[2],'entered');
        const timer=setInterval(()=>{if(existsSync(process.argv[3])){clearInterval(timer);reply({prompts:[{name:'receipt',description:'Read a shipment receipt'}]})}},10);
        return;
      }
      reply({});
    });
  `,
  )
  write(join(directory, '.claude-plugin/plugin.json'), {
    name,
    version: '1.0.0',
    mcpServers: {
      shipping: {
        command: process.execPath,
        args: [script, entered, released],
      },
    },
  })
  r.setInlinePlugins([directory])
  r.resetSettingsCache()
  r.clearAllCaches()
  const owner = (await r.loadAllPluginsCacheOnly()).enabled.find(
    plugin => plugin.name === name,
  )
  assert.ok(owner)
  const [server, config] = Object.entries(await r.getPluginMcpServers(owner))[0]
  return {
    server,
    config,
    entered,
    releasePrompts: () => write(released, 'ready'),
    connect: signal =>
      r.runModMcpAPI('mcp.connect', { server: 'shipping' }, signal, owner),
  }
}

test(
  'direct MCP synchronous publication settles tools without waiting for ancillary discovery',
  { timeout: 20000 },
  async () => {
    const f = await fixture()
    const controller = new AbortController()
    let state = { clients: [], tools: [], commands: [], resources: {} }
    const release = r.registerModMcpPublisher((update, current) => {
      if (!current || current()) state = r.applyModMcpUpdate(state, update)
    })
    try {
      assert.deepEqual(await f.connect(controller.signal), {
        isConnected: true,
        server: f.server,
      })
      await until(() => existsSync(f.entered))
      assert.equal(
        state.tools.filter(tool => tool.mcpInfo?.serverName === f.server)
          .length,
        1,
      )
      assert.equal(
        state.commands.length,
        0,
        'The prompt listing must still be blocked',
      )
      assert.equal(
        r.isMcpDiscoverySettled(),
        true,
        'A slow prompt listing must not hold usable tools behind the launch barrier',
      )
      // Completing a normal mod invocation aborts its signal. Ancillary discovery
      // must still update the same live connection afterwards.
      controller.abort()
      f.releasePrompts()
      await until(() => state.commands.length === 1)
      assert.equal(r.isMcpDiscoverySettled(), true)
    } finally {
      controller.abort()
      f.releasePrompts()
      release()
      await r.clearServerCache(f.server, f.config)
      r.forgetMcpServer(f.server)
    }
  },
)

test(
  'direct MCP deferred publication holds readiness until tools reach the owning store',
  { timeout: 20000 },
  async () => {
    const f = await fixture()
    const controller = new AbortController()
    const queued = []
    let state = { clients: [], tools: [], commands: [], resources: {} }
    const release = r.registerModMcpPublisher(
      (update, current) => queued.push({ update, current }),
      true,
    )
    try {
      assert.deepEqual(await f.connect(controller.signal), {
        isConnected: true,
        server: f.server,
      })
      await until(() => existsSync(f.entered))
      assert.equal(state.tools.length, 0)
      assert.equal(r.isMcpServerPublishing(f.server), true)
      assert.equal(r.isMcpDiscoverySettled(), false)
      f.releasePrompts()
      await until(() => queued.some(item => item.update.commands?.length))
      // Finishing discovery is still insufficient: a model request must not run
      // against the empty catalog during the UI's batching interval.
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(r.isMcpServerPublishing(f.server), true)
      assert.equal(r.isMcpDiscoverySettled(), false)
      for (const { update, current } of queued) {
        assert.equal(current(), true)
        state = r.applyModMcpUpdate(state, update)
        r.acknowledgeMcpPublication(update.client.name)
      }
      assert.equal(
        state.tools.filter(tool => tool.mcpInfo?.serverName === f.server)
          .length,
        1,
      )
      assert.equal(state.commands.length, 1)
      assert.equal(r.isMcpDiscoverySettled(), true)
    } finally {
      controller.abort()
      f.releasePrompts()
      release()
      await r.clearServerCache(f.server, f.config)
      r.forgetMcpServer(f.server)
    }
  },
)
