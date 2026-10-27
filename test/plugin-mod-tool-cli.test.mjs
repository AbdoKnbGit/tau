import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID, randomInt } from 'node:crypto'
import { test } from 'node:test'
import { anthropicReply } from './mcp-instructions/anthropic-reply.mjs'

const cli = resolve('dist/cli.mjs')
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data))
}
test(
  'real Tau tool calls use mod tools, rewritten inputs, permission checks, and scoped tool APIs',
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'tau-mod-tool-cli-')),
      project = join(root, 'workspace'),
      plugin = join(root, 'plugin'),
      config = join(root, 'config')
    mkdirSync(project)
    const receipt = randomUUID(),
      left = randomInt(11, 50),
      right = randomInt(50, 99)
    write(join(project, 'input.txt'), receipt)
    write(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'calculator-mod',
      version: '1.0.0',
    })
    write(join(plugin, 'hooks/hooks.json'), { modules: ['./register.ts'] })
    write(
      join(plugin, 'hooks/register.ts'),
      `export function register(on){
on('session.start',async($,e,next)=>{
 await $.tool.register({name:'total',description:'Add two quantities',inputSchema:{type:'object',properties:{left:{type:'integer'},right:{type:'integer'}},required:['left','right'],additionalProperties:false},isDeferred:false});
 await $.tool.register({name:'deferred_total',description:'Add two quantities after explicit discovery',inputSchema:{type:'object',properties:{left:{type:'integer'},right:{type:'integer'}},required:['left','right'],additionalProperties:false}});
 await $.command.register({name:'api-check',description:'Query permission without running a tool'});
 await $.command.register({name:'api-read',description:'Read via the same tool path'});
 return next(e);
});
on('tool.call',{tool:'mcp__calculator-mod__total'},async($,e)=>({result:{total:e.left+e.right,receipt:await $.fs.read('input.txt')}}));
on('tool.call',{tool:'mcp__calculator-mod__deferred_total'},async($,e)=>({result:{total:e.left+e.right,receipt:await $.fs.read('input.txt')}}));
on('tool.call',{tool:'Write'},async($,e,next)=>{const r=await next({...e,file_path:e.file_path.replace('original.txt','rewritten.txt')});return {...r,context:['MOD-TOOL-CONTEXT']}});
on('tool.check',{tool:'Bash'},async($,e,next)=>{const result=await next(e);if(e.input.command.includes('MUST-NOT-EXECUTE'))return {decision:'deny',reason:'MOD-PERMISSION-DENIED'};return result});
on('command.run',{command:'api-check'},async($,e)=>{const r=await $.tool.check({tool:'Write',input:{file_path:'query-only.txt',content:'never written'}});await $.fs.write('query-result.json',JSON.stringify(r));return {text:JSON.stringify(r)}});
on('command.run',{command:'api-read'},async($,e)=>{const r=await $.tool.call({tool:'Read',file_path:'input.txt'});return {text:r.text}});
}`,
    )
    const requests = []
    let mode = 'model',
      sent = false,
      discoveryCalls = 0
    const server = createServer(async (request, response) => {
      if (request.method === 'HEAD') {
        response.end()
        return
      }
      let raw = ''
      for await (const part of request) raw += part
      if (
        !request.url.includes('/messages') ||
        request.url.includes('count_tokens')
      ) {
        response.setHeader('content-type', 'application/json')
        response.end('{"input_tokens":100}')
        return
      }
      const body = JSON.parse(raw)
      requests.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'discovery') {
        const calls = discoveryCalls++
        response.end(
          anthropicReply(
            calls === 0
              ? [
                  {
                    name: 'ToolSearch',
                    input: {
                      query: 'select:mcp__calculator-mod__deferred_total',
                      max_results: 1,
                    },
                  },
                ]
              : calls === 1
                ? [
                    {
                      name: 'mcp__calculator-mod__deferred_total',
                      input: { left, right },
                    },
                  ]
                : 'MOD-DISCOVERY-COMPLETE',
            body.model,
          ),
        )
        return
      }
      if (mode !== 'model') {
        response.end(anthropicReply('UNEXPECTED-MODEL-REQUEST', body.model))
        return
      }
      if (!sent) {
        sent = true
        response.end(
          anthropicReply(
            [
              {
                name: 'Write',
                input: {
                  file_path: join(project, 'original.txt'),
                  content: receipt,
                },
              },
              {
                name: 'Bash',
                input: { command: 'echo MUST-NOT-EXECUTE > forbidden.txt' },
              },
              { name: 'mcp__calculator-mod__total', input: { left, right } },
            ],
            body.model,
          ),
        )
      } else response.end(anthropicReply('MOD-TOOLS-COMPLETE', body.model))
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
      ANTHROPIC_API_KEY: 'sk-ant-local-tool-test',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      NO_PROXY: '127.0.0.1,localhost',
      ENABLE_TOOL_SEARCH: 'false',
    })
    write(join(config, '.claude.json'), {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      activeProvider: 'firstParty',
    })
    const exits = []
    async function run(prompt) {
      const child = spawn(
        process.execPath,
        [
          cli,
          '-p',
          prompt,
          '--model',
          'claude-sonnet-4-6',
          '--plugin-dir',
          plugin,
          '--strict-mcp-config',
          '--setting-sources',
          'project',
          '--no-session-persistence',
          '--dangerously-skip-permissions',
          '--max-turns',
          '4',
        ],
        {
          cwd: project,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (part) => (stdout += part))
      child.stderr.on('data', (part) => (stderr += part))
      const timer = setTimeout(() => child.kill(), 35000)
      try {
        const code = await new Promise((done, reject) => {
          child.once('close', done)
          child.once('error', reject)
        })
        exits.push({ code, stderr })
        assert.equal(code, 0, stderr + '\n' + stdout)
        return stdout
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const output = await run(
        'Perform the three tool actions and report completion.',
      )
      assert.match(output, /MOD-TOOLS-COMPLETE/)
      assert.equal(
        readFileSync(join(project, 'rewritten.txt'), 'utf8'),
        receipt,
      )
      assert.equal(existsSync(join(project, 'original.txt')), false)
      assert.equal(existsSync(join(project, 'forbidden.txt')), false)
      assert.equal(requests.length, 2)
      assert.ok(
        requests[0].tools.some(
          (tool) => tool.name === 'mcp__calculator-mod__total',
        ),
        'Registered tool must appear on the first prompt',
      )
      const messages = JSON.stringify(requests[1].messages)
      assert.ok(messages.includes('MOD-PERMISSION-DENIED'))
      assert.ok(messages.includes('MOD-TOOL-CONTEXT'))
      assert.ok(messages.includes(String(left + right)))
      assert.ok(messages.includes(receipt))
      const prefix = requests[0].system.filter(
        (block) => !block.text?.startsWith('x-anthropic-billing-header:'),
      )
      assert.deepEqual(
        requests[1].system.filter(
          (block) => !block.text?.startsWith('x-anthropic-billing-header:'),
        ),
        prefix,
        'Tool middleware must not rewrite the frozen system prefix',
      )
      assert.deepEqual(
        requests[1].tools,
        requests[0].tools,
        'Ordinary tool calls must not churn tool schemas',
      )
      mode = 'query'
      const before = requests.length
      const queried = await run('/api-check')
      assert.ok(queried.includes('allow'))
      assert.equal(existsSync(join(project, 'query-only.txt')), false)
      const query = JSON.parse(
        readFileSync(join(project, 'query-result.json'), 'utf8'),
      )
      assert.equal(query.decision, 'allow')
      assert.equal(query.tool_use_id, undefined)
      const read = await run('/api-read')
      assert.ok(read.includes(receipt), read)
      assert.equal(
        requests.length,
        before,
        'Local API commands must not request a model',
      )
      mode = 'discovery'
      env.ENABLE_TOOL_SEARCH = 'true'
      const discoveryAt = requests.length
      const discoveryOutput = await run(
        'Discover and use the deferred calculation tool.',
      )
      assert.ok(discoveryOutput.includes('MOD-DISCOVERY-COMPLETE'))
      const discovery = requests.slice(discoveryAt)
      assert.equal(discovery.length, 3)
      assert.ok(
        discovery[0].tools.some(
          (tool) =>
            tool.name === 'mcp__calculator-mod__deferred_total' &&
            tool.defer_loading === true,
        ),
        'Default registered tools must use native deferred schema placement',
      )
      assert.ok(
        JSON.stringify(discovery[1].messages).includes('tool_reference'),
        'Real ToolSearch must expose the registered tool reference',
      )
      assert.ok(
        JSON.stringify(discovery[2].messages).includes(receipt),
        'The discovered tool must execute its actual mod handler',
      )
      assert.deepEqual(
        discovery[2].tools,
        discovery[0].tools,
        'Discovery must keep the native tool prefix stable',
      )
      await t.test(
        'native process shutdown exits cleanly',
        () => {
          assert.ok(
            exits.every((exit) => exit.code === 0),
            'Functional assertions completed, but native Windows process shutdown failed',
          )
        },
      )
    } finally {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      if (exits.some((exit) => exit.code !== 0))
        t.diagnostic('Native shutdown failure evidence retained at ' + root)
      else
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        })
    }
  },
)
