import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { resolveWindowsSystemExecutable } from '../scripts/platform-support.mjs'

const cli = resolve('dist/cli.mjs')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

// The CLI can re-exec another Node runtime. Kill its process tree, otherwise the
// replacement can retain stdout/stderr and prevent the wrapper's close event.
function waitForChild(child, { timeout, signal }) {
  return new Promise((resolve, reject) => {
    let reason,
      forceTimer,
      finished = false
    const finish = (error, code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', abort)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (error) reject(error)
      else resolve(code)
    }
    const stop = error => {
      if (reason || finished) return
      reason = error
      // Bound even cleanup failure: an inherited pipe must never strand the test.
      forceTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.unref()
        finish(
          new Error('Child process tree did not close after termination', {
            cause: reason,
          }),
        )
      }, 30_000)
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return
      if (process.platform === 'win32') {
        const taskkill = resolveWindowsSystemExecutable('taskkill.exe')
        if (taskkill) {
          const result = spawnSync(
            taskkill,
            ['/PID', String(child.pid), '/T', '/F'],
            {
              windowsHide: true,
              stdio: 'ignore',
              timeout: 30_000,
            },
          )
          if (result.error)
            reason = new Error('Could not terminate child process tree', {
              cause: result.error,
            })
        } else {
          reason = new Error(
            'Cannot resolve Windows taskkill for process-tree cleanup',
            { cause: reason },
          )
          child.kill('SIGKILL')
        }
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') reason = error
        }
      }
    }
    const abort = () => stop(signal.reason ?? new Error('Test aborted'))
    const onError = error => finish(error)
    const onClose = code => finish(reason, code)
    const timer = setTimeout(
      () => stop(new Error(`Child process timed out after ${timeout}ms`)),
      timeout,
    )
    child.once('error', onError)
    child.once('close', onClose)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

test(
  'CLI test cancellation closes descendants holding inherited output pipes',
  { timeout: 90_000 },
  async t => {
    const controller = new AbortController()
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit'],windowsHide:true});
    console.log(descendant.pid);
    setInterval(()=>{},1000);
  `,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      },
    )
    const completion = waitForChild(child, {
      timeout: 30_000,
      signal: AbortSignal.any([t.signal, controller.signal]),
    })
    // Attach the rejection assertion before aborting, so rejection is always owned.
    const stopped = assert.rejects(completion, /fixture cancellation/)
    const descendant = await new Promise((resolve, reject) => {
      let output = ''
      child.stdout.on('data', data => {
        output += data
        if (output.includes('\n')) resolve(Number(output.trim()))
      })
      child.once('error', reject)
      child.once('close', () =>
        reject(new Error('Fixture exited before reporting its descendant')),
      )
    })
    assert.ok(Number.isInteger(descendant) && descendant > 0)
    controller.abort(new Error('fixture cancellation'))
    await stopped
    // A killed process stays visible for a moment, until the system has collected it.
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        process.kill(descendant, 0)
      } catch (error) {
        assert.equal(error.code, 'ESRCH')
        break
      }
      assert.ok(Date.now() < deadline, 'the descendant is still running')
      await new Promise(done => setTimeout(done, 50))
    }
  },
)

test(
  'shipped CLI connects its manifest server and calls raw MCP without a model request',
  { timeout: 240_000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'tau mod MCP CLI é '))
    const workspace = join(root, 'workspace'),
      config = join(root, 'config'),
      plugin = join(root, 'plugin')
    mkdirSync(workspace)
    const receipt = randomUUID(),
      quantity = randomInt(2, 15),
      price = randomInt(10, 80)
    const calls = join(workspace, 'wire.jsonl')
    const modelRequests = []
    const model = createServer((request, response) => {
      if (request.method !== 'HEAD') modelRequests.push(request.url)
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            type: 'authentication_error',
            message: 'Unexpected model request',
          },
        }),
      )
    })
    await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(CLAUDE|ANTHROPIC|OPENAI|GEMINI|TAU_|CLAUDEX|CODEX_|ENABLE_TOOL_SEARCH|SESSIONNAME$|WT_SESSION$|ConEmuPID$)/i.test(
            key,
          ),
      ),
    )
    Object.assign(env, {
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      APPDATA: join(root, 'appdata'),
      LOCALAPPDATA: join(root, 'localappdata'),
      CLAUDE_CONFIG_DIR: config,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'cache'),
      CI: 'true',
      NODE_ENV: 'production',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      TAU_SKIP_PREFLIGHT: '1',
      ANTHROPIC_API_KEY: 'sk-ant-fixture',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.address().port}`,
      NO_PROXY: '127.0.0.1,localhost',
    })
    write(join(config, '.claude.json'), {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      activeProvider: 'firstParty',
    })
    const server = join(plugin, 'server with spaces.mjs')
    write(
      server,
      `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    appendFileSync(process.argv[2],JSON.stringify({event:'start'})+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
      let result={};
      if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,serverInfo:{name:'quote',version:'1'},capabilities:{tools:{}}};
      if(q.method==='tools/list')result={tools:[{name:'quote',description:'Calculate shipment price',inputSchema:{type:'object'}}]};
      if(q.method==='tools/call'){
        appendFileSync(process.argv[2],JSON.stringify({event:'call',...q.params})+'\\n');
        const a=q.params.arguments;
        result={content:[{type:'text',text:'receipt:'+a.receipt}],structuredContent:{amount:a.quantity*a.price,receipt:a.receipt}};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
    });`,
    )
    write(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'freight',
      version: '1.0.0',
      mcpServers: {
        quotes: { command: process.execPath, args: [server, calls] },
      },
    })
    write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(join(workspace, 'input.json'), { receipt, quantity, price })
    write(
      join(plugin, 'hooks/register.ts'),
      `export function register(on){
    on('session.start',async($,e,next)=>{
      await $.command.register({name:'direct-quote',description:'Get a freight quote'});
      const connected=await $.mcp.connect('quotes');
      await $.fs.write('started.json',JSON.stringify(connected));return next(e);
    });
    on('command.run',{command:'direct-quote'},async($)=>{
      const c=await $.mcp.connect('quotes');
      const output=c.isConnected?await $.mcp.call(c.server,'quote',JSON.parse(await $.fs.read('input.json'))):c;
      await $.fs.write('answer.json',JSON.stringify(output));return {text:JSON.stringify(output)};
    });
  }`,
    )
    async function run(extra = []) {
      const debugFile = join(workspace, 'cli-debug.log')
      const child = spawn(
        process.execPath,
        [
          cli,
          '-p',
          '/direct-quote',
          '--model',
          'claude-sonnet-4-6',
          '--plugin-dir',
          plugin,
          '--setting-sources',
          'project',
          '--no-session-persistence',
          '--debug-file',
          debugFile,
          ...extra,
        ],
        {
          cwd: workspace,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', value => {
        stdout += value
      })
      child.stderr.on('data', value => {
        stderr += value
      })
      // Loading the shipped bundle from a mounted checkout can itself exceed
      // forty seconds (e.g. Windows files accessed through WSL's 9p mount).
      try {
        const code = await waitForChild(child, {
          timeout: 90_000,
          signal: t.signal,
        })
        assert.equal(
          code,
          0,
          `${stdout}\n${stderr}\n${existsSync(debugFile) ? readFileSync(debugFile, 'utf8').slice(-14000) : 'No debug log'}`,
        )
        assert.doesNotMatch(
          stderr,
          /must be rendered inside|hook skipped|mod did not load/,
        )
        return stdout
      } catch (error) {
        throw new Error(`${error.message}\n${stdout}\n${stderr}`, {
          cause: error,
        })
      }
    }
    try {
      const output = await run()
      assert.match(output, new RegExp(receipt))
      const answer = JSON.parse(
        readFileSync(join(workspace, 'answer.json'), 'utf8'),
      )
      assert.deepEqual(answer.structuredContent, {
        amount: quantity * price,
        receipt,
      })
      assert.equal(answer.isError, false)
      assert.deepEqual(
        JSON.parse(readFileSync(join(workspace, 'started.json'), 'utf8')),
        { isConnected: true, server: 'plugin:freight:quotes' },
      )
      const wire = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse)
      assert.equal(wire.filter(row => row.event === 'start').length, 1)
      assert.equal(wire.filter(row => row.event === 'call').length, 1)
      await run(['--strict-mcp-config'])
      assert.equal(
        JSON.parse(readFileSync(join(workspace, 'answer.json'), 'utf8')).reason,
        'unlisted',
      )
      assert.equal(
        readFileSync(calls, 'utf8').trim().split('\n').length,
        wire.length,
        'Strict config must not launch the manifest server',
      )
      assert.deepEqual(
        modelRequests,
        [],
        'Local mod commands must not call a model',
      )
    } finally {
      model.closeAllConnections()
      await new Promise(resolve => model.close(resolve))
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    }
  },
)
