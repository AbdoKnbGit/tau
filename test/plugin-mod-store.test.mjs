import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'tau-mod-store-'))
const original = process.cwd()
const project = join(root, 'project'),
  cache = join(root, 'cache')
mkdirSync(project)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
})
const helper = pathToFileURL(resolve('test/helpers/ink-built-runtime.mjs')).href
process.chdir(project)
const r = await loadBuiltRuntime({
  paths: ['src/utils/plugins/mods/host.ts'],
  exports: ['createModHost', 'getPluginDataDir'],
})
const signal = new AbortController().signal
const host = (id) =>
  r.createModHost({
    id,
    name: id,
    commands: new Map(),
    reserved: new Set(),
    commandsChanged: async () => {},
    log() {},
  })
const call = (api, method, ...args) => api('store.' + method, args, signal)
after(() => {
  process.chdir(original)
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
})

test('exact plugin identities remain isolated when their legacy directory names collide', async () => {
  const first = 'a-b@c',
    second = 'a@b-c'
  assert.equal(r.getPluginDataDir(first), r.getPluginDataDir(second))
  // Existing single-owner stores retain their data when upgraded.
  writeFileSync(
    join(r.getPluginDataDir(first), 'mod-store.json'),
    JSON.stringify([['legacy', 3]]),
  )
  const a = host(first),
    b = host(second)
  assert.equal(await call(a, 'get', 'legacy'), 3)
  assert.equal(await call(b, 'get', 'legacy'), undefined)
  await call(a, 'set', 'only-a', 'a')
  await call(b, 'set', 'only-b', 'b')
  assert.equal(await call(a, 'get', 'only-b'), undefined)
  assert.equal(await call(b, 'get', 'only-a'), undefined)
  assert.deepEqual(await call(host(first), 'keys'), ['legacy', 'only-a'])
  assert.deepEqual(await call(host(second), 'keys'), ['only-b'])
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(r.getPluginDataDir(first), 'mod-store.json'), 'utf8'),
    ),
    [
      ['legacy', 3],
      ['only-a', 'a'],
    ],
  )
})

test(
  'simultaneous Tau processes keep every independent store update',
  { timeout: 40_000 },
  async () => {
    const childPath = join(root, 'writer.mjs')
    writeFileSync(
      childPath,
      `import {loadBuiltRuntime} from ${JSON.stringify(helper)};
const r=await loadBuiltRuntime({paths:['src/utils/plugins/mods/host.ts'],exports:['createModHost']});
const host=r.createModHost({id:'shared@store-test',name:'shared',commands:new Map(),reserved:new Set(),commandsChanged:async()=>{},log(){}});
const start=new Promise(resolve=>process.once('message',resolve));process.send('ready');await start;
for(let i=0;i<12;i++) await host('store.set',[process.argv[2]+':'+i,{writer:process.argv[2],index:i}],new AbortController().signal);
process.disconnect();`,
    )
    const writers = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(process.execPath, [childPath, String(index)], {
        cwd: project,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data
      })
      const done = new Promise((resolveResult, reject) => {
        const timeout = setTimeout(() => {
          child.kill()
          reject(new Error('Store writer timed out'))
        }, 30_000)
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timeout)
          code === 0
            ? resolveResult()
            : reject(new Error(`Writer ${index} exited ${code}: ${stderr}`))
        })
      })
      const ready = new Promise((resolveReady, reject) => {
        child.once('message', () => resolveReady())
        done.catch(reject)
      })
      return { child, done, ready }
    })
    try {
      await Promise.all(writers.map((writer) => writer.ready))
      for (const writer of writers) writer.child.send('start')
      await Promise.all(writers.map((writer) => writer.done))
      const api = host('shared@store-test')
      const keys = await call(api, 'keys')
      assert.equal(
        keys.length,
        48,
        "A process lost another writer's stored key",
      )
      for (let writer = 0; writer < 4; writer++)
        for (let index = 0; index < 12; index++) {
          assert.deepEqual(await call(api, 'get', `${writer}:${index}`), {
            writer: String(writer),
            index,
          })
        }
    } finally {
      for (const writer of writers)
        if (writer.child.exitCode === null) writer.child.kill()
      await Promise.allSettled(writers.map((writer) => writer.done))
    }
  },
)
