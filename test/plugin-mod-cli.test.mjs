import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID, randomInt } from 'node:crypto'
import { test } from 'node:test'

const cli = resolve(process.env.TAU_TEST_CLI ?? 'dist/cli.mjs')
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
async function run(args, cwd, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = '',
    timedOut = false
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, 40_000)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', done)
    })
    assert.equal(timedOut, false, `CLI timed out: ${stderr}\n${stdout}`)
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

test(
  'shipped CLI loads a TypeScript mod on first startup and runs real external programs without a model request',
  { timeout: 180_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'tau-mod-cli-'))
    const workspace = join(root, 'workspace'),
      config = join(root, 'config'),
      plugin = join(root, 'plugin')
    mkdirSync(workspace)
    const requests = []
    const server = createServer((request, response) => {
      if (request.method !== 'HEAD')
        requests.push(`${request.method} ${request.url}`)
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
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
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
      ANTHROPIC_API_KEY: 'sk-ant-mod-fixture',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1,localhost',
    })
    write(join(config, '.claude.json'), {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      activeProvider: 'firstParty',
    })
    write(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'measurement',
      version: '1.0.0',
    })
    write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(
      join(plugin, 'hooks/register.ts'),
      `import { label } from './label.js';
export function register(on) {
  on('session.start', async ($, e, next) => { await $.command.register({name:'measure',description:'Calculate from the supplied input'}); await $.fs.write('started.json',JSON.stringify({session:await $.session.id()})); return next(e); });
  on('session.end', async ($, e, next) => { await $.fs.write('ended.json',JSON.stringify(e));return next(e); });
  on('command.run', {command:'measure'}, async ($, e) => {
    const input = await $.fs.read('input.json');
    const argv: string[] = JSON.parse(await $.fs.read('program.json'));
    const result = await $.process.run(argv, {stdin:input});
    if (result.exitCode !== 0) throw new Error(result.stderr);
    const previous = Number((await $.store.get('runs')) ?? 0); await $.store.set('runs',previous+1);
    return {text:label+':'+result.stdout.trim()+':run='+(previous+1)};
  });
}`,
    )
    write(
      join(plugin, 'hooks/label.ts'),
      'export const label: string = "calculated";',
    )
    const input = {
      quantity: randomInt(2, 19),
      price: randomInt(5, 81),
      receipt: randomUUID(),
    }
    write(join(workspace, 'input.json'), input)
    const expected = `${input.quantity * input.price}:${input.receipt}`
    const scripts = [
      {
        name: 'Node',
        argv: [process.execPath, join(workspace, 'helper.cjs')],
        path: 'helper.cjs',
        source: `let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{const v=JSON.parse(text);console.log(v.quantity*v.price+':'+v.receipt)})`,
      },
      {
        name: 'Python',
        available:
          spawnSync('python', ['--version'], { windowsHide: true }).status ===
          0,
        argv: ['python', join(workspace, 'helper.py')],
        path: 'helper.py',
        source:
          'import json,sys\nv=json.load(sys.stdin)\nprint(str(v["quantity"]*v["price"])+":"+v["receipt"])\n',
      },
    ]
    const goPath = join(
      workspace,
      process.platform === 'win32' ? 'helper-go.exe' : 'helper-go',
    )
    if (spawnSync('go', ['version'], { windowsHide: true }).status === 0) {
      write(
        join(workspace, 'helper.go'),
        'package main\nimport("encoding/json";"fmt";"os")\nfunc main(){var v struct{Quantity int;Price int;Receipt string};if err:=json.NewDecoder(os.Stdin).Decode(&v);err!=nil{panic(err)};fmt.Printf("%d:%s\\n",v.Quantity*v.Price,v.Receipt)}\n',
      )
      const build = spawnSync('go', ['build', '-o', goPath, 'helper.go'], {
        cwd: workspace,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 45_000,
      })
      assert.equal(build.status, 0, build.stderr)
      scripts.push({ name: 'Go executable', argv: [goPath] })
    }
    let count = 0
    try {
      for (const script of scripts)
        await t.test(
          script.name,
          { skip: script.available === false },
          async () => {
            if (script.path) write(join(workspace, script.path), script.source)
            write(join(workspace, 'program.json'), script.argv)
            const result = await run(
              [
                '-p',
                '/measure',
                '--model',
                'claude-sonnet-4-6',
                '--plugin-dir',
                plugin,
                '--strict-mcp-config',
                '--setting-sources',
                'project',
                '--no-session-persistence',
              ],
              workspace,
              env,
            )
            assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`)
            const ended = JSON.parse(readFileSync(join(workspace, 'ended.json'), 'utf8'))
            const started = JSON.parse(readFileSync(join(workspace, 'started.json'), 'utf8'))
            assert.equal(ended.reason, 'other')
            assert.equal(ended.resume.id, ended.sessionId)
            assert.equal(ended.sessionId, started.session, 'Exit evidence must belong to this exact fresh session')
            assert.ok(
              result.stdout.includes(`calculated:${expected}:run=${++count}`),
              `${result.stderr}\n${result.stdout}`,
            )
            assert.deepEqual(
              requests,
              [],
              'The local mod command must not reach a model',
            )
          },
        )
      await t.test(
        'validation inspects unsupported APIs without executing register',
        async () => {
          write(
            join(plugin, 'hooks/register.ts'),
            "throw new Error('MUST_NOT_EXECUTE'); export function register(on){on('tool.describe',async($,e,next)=>next(e))}",
          )
          const result = await run(
            ['plugin', 'validate', plugin],
            workspace,
            env,
          )
          assert.notEqual(result.code, 0)
          assert.match(
            result.stdout + result.stderr,
            /does not yet support mod event/,
          )
          assert.doesNotMatch(
            result.stdout + result.stderr,
            /Error: MUST_NOT_EXECUTE/,
          )
        },
      )
    } finally {
      await new Promise((done) => server.close(done))
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    }
  },
)
