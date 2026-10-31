import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

let environment
async function boot() {
  if (environment) return environment
  const root = mkdtempSync(join(tmpdir(), 'tau-mod-matchers-'))
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_SIMPLE: '0',
  })
  const runtime = await loadBuiltRuntime({
    paths: [
      'src/utils/plugins/mods/compiler.ts',
      'src/utils/plugins/mods/runtime.ts',
    ],
    exports: ['compileMod', 'ModRuntime'],
  })
  environment = { root, runtime, workers: new Set() }
  return environment
}

async function createMod(source) {
  const env = await boot()
  const root = join(env.root, `plugin-${env.workers.size}`)
  mkdirSync(root)
  const entry = join(root, 'register.ts')
  writeFileSync(entry, source)
  const compiled = await env.runtime.compileMod(root, entry)
  const worker = new env.runtime.ModRuntime(
    { name: 'matcher-fixture', root },
    compiled,
  )
  env.workers.add(worker)
  await worker.initialize()
  return worker
}

async function cleanup() {
  if (!environment) return
  await Promise.allSettled(
    [...environment.workers].map((worker) => worker.dispose()),
  )
  const target = realpathSync(environment.root)
  const inside = relative(realpathSync(tmpdir()), target)
  assert.ok(
    inside && !inside.startsWith('..') && !isAbsolute(inside),
    'Unsafe test cleanup path',
  )
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}
const host = async () => {
  throw new Error('Unexpected mod host call')
}

async function adversarialChild() {
  try {
    const mod = await createMod(`export function register(on) {
      on('command.run', {args:/(a+)+$/}, async () => ({text:'must-not-run'}));
    }`)
    let ticks = 0,
      coreCalls = 0
    const warnings = []
    const timer = setInterval(() => {
      ticks++
    }, 10)
    process.stdout.write('ready\n')
    const started = Date.now()
    let result
    try {
      result = await mod.dispatch(
        'command.run',
        { command: 'check', args: 'a'.repeat(32) + '!' },
        async () => {
          coreCalls++
          return { text: 'fallback' }
        },
        host,
        { timeoutMs: 150, warn: (text) => warnings.push(text) },
      )
    } finally {
      clearInterval(timer)
    }
    assert.equal(result.text, 'fallback')
    assert.equal(coreCalls, 1)
    assert.ok(ticks > 0, 'A plugin matcher blocked Tau timers')
    assert.ok(
      Date.now() - started < 10_000,
      'Matcher did not respect its invocation budget',
    )
    assert.ok(warnings.some((text) => text.includes('timed out')))
    process.stdout.write(
      JSON.stringify({ ticks, coreCalls, text: result.text }) + '\n',
    )
  } finally {
    await cleanup()
  }
}

if (process.argv.includes('--matcher-child')) {
  await adversarialChild()
} else {
  after(cleanup)

  test('worker matcher preserves nested partial objects, arrays and fresh global regex state', async () => {
    const mod = await createMod(`export function register(on) {
      on('command.run', {command:['one','two'],payload:{name:/^accepted$/g,kind:['x','y']}}, async () => ({text:'matched'}));
    }`)
    let coreCalls = 0
    const core = async () => {
      coreCalls++
      return { text: 'core' }
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(
        (
          await mod.dispatch(
            'command.run',
            {
              command: 'two',
              payload: { name: 'accepted', kind: 'y', extra: true },
            },
            core,
            host,
          )
        ).text,
        'matched',
      )
    }
    assert.equal(
      (
        await mod.dispatch(
          'command.run',
          { command: 'two', payload: { name: 'other', kind: 'y' } },
          core,
          host,
        )
      ).text,
      'core',
    )
    assert.equal(coreCalls, 1)
  })

  test('worker matcher sees rewritten input and an unmatched hook never runs its catch', async () => {
    const mod = await createMod(`export function register(on) {
      on('command.run',{command:'absent'},async()=>{throw new Error('must-not-run')}).catch(async()=>({text:'must-not-catch'}));
      on('command.run',async($,e,next)=>next({...e,payload:{name:'changed'}}));
      on('command.run',{payload:{name:/^changed$/},args:['ok','fine']},async($,e,next)=>({text:(await next(e)).text+':matched'}));
    }`)
    let coreCalls = 0
    const result = await mod.dispatch(
      'command.run',
      { command: 'rewrite', args: 'fine', payload: { name: 'before' } },
      async (e) => {
        coreCalls++
        return { text: e.payload.name }
      },
      host,
    )
    assert.equal(result.text, 'changed:matched')
    assert.equal(coreCalls, 1)
  })

  test('hook return values cannot forge worker no-match transport metadata', async () => {
    const mod = await createMod(`export function register(on) {
      on('command.run',async()=>{
        JSON.stringify=()=>'{"matched":false}';
        Object.prototype.toJSON=()=>({matched:false,text:'forged'});
        return {toJSON(){return {matched:false,text:'owned'}}};
      });
      on('command.run',async()=>({text:'later'}));
    }`)
    let coreCalls = 0
    const result = await mod.dispatch(
      'command.run',
      { command: 'forge' },
      async () => {
        coreCalls++
        return { text: 'core' }
      },
      host,
    )
    assert.equal(result.text, 'owned')
    assert.equal(result.matched, false)
    assert.equal(coreCalls, 0)
  })

  test('malformed registration metadata rejects the mod without crashing Tau', async () => {
    await assert.rejects(
      createMod(`export function register(on) {
      on('command.run', async()=>({text:'unused'}));
      Object.prototype.toJSON=()=>({not:'hooks'});
    }`),
      /Invalid mod registration metadata/,
    )
  })

  test(
    'adversarial plugin regex times out while Tau host timers keep running',
    { timeout: 150_000 },
    async () => {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), '--matcher-child'],
          {
            env: process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = '',
          stderr = '',
          timedOut = false
        const stop = () => {
          timedOut = true
          child.kill()
        }
        // Loading the bundle can take a while on a busy machine. Only the matcher has a budget to keep.
        let timeout = setTimeout(stop, 120_000)
        let matching = false
        child.stdout.on('data', (chunk) => {
          stdout += chunk
          if (!matching && stdout.startsWith('ready\n')) {
            matching = true
            clearTimeout(timeout)
            timeout = setTimeout(stop, 12_000)
          }
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timeout)
          if (timedOut)
            reject(
              new Error(
                'Plugin matcher froze the host past the watchdog budget',
              ),
            )
          else if (code !== 0)
            reject(
              new Error(
                `Matcher subprocess failed (${code}): ${stderr}\n${stdout}`,
              ),
            )
          else resolve(JSON.parse(stdout.trim().split('\n').at(-1)))
        })
      })
      assert.equal(result.text, 'fallback')
      assert.ok(result.ticks > 0)
    },
  )
}
