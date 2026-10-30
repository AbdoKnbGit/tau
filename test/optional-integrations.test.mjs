// The smaller gaps a missing package used to leave, through the shipped bundle.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

const repositoryRoot = process.cwd()
const bundlePath = resolve('dist/tau.mjs')
process.env.TAU_MCP_TEST_BUNDLE ??= bundlePath
const root = mkdtempSync(join(tmpdir(), 'tau optional é-'))
const project = join(root, 'project')
mkdirSync(project, { recursive: true })
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  COLORTERM: 'truecolor',
})
process.chdir(project)
after(() => {
  process.chdir(repositoryRoot)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

const runtime = await loadMcpRuntime({
  paths: [
    'src/utils/cliHighlight.ts',
    'src/utils/yaml.ts',
    'src/utils/claudeInChrome/common.ts',
    'src/utils/claudeInChrome/setup.ts',
  ],
  exports: [
    'getCliHighlightPromise',
    'getLanguageName',
    'parseYaml',
    'isClaudeInChromeAvailable',
    'isClaudeInChromeMCPServer',
    'shouldEnableClaudeInChrome',
  ],
})

test('the highlighter works without cli-highlight', async () => {
  const highlighter = await runtime.getCliHighlightPromise()
  assert.ok(highlighter, 'the highlighter failed to load')
  assert.equal(highlighter.supportsLanguage('typescript'), true)
  assert.equal(highlighter.supportsLanguage('not-a-language'), false)
  const colored = highlighter.highlight('const answer = 42', { language: 'typescript' })
  assert.match(colored, /\u001b\[/, 'expected ANSI color')
  assert.equal(colored.replace(/\u001b\[[0-9;]*m/g, ''), 'const answer = 42')
})

test('language names resolve through highlight.js', async () => {
  assert.equal(await runtime.getLanguageName('src/example.ts'), 'TypeScript')
  assert.equal(await runtime.getLanguageName('no-extension'), 'unknown')
})

test('yaml is a declared dependency, not a lucky transitive one', () => {
  const pkg = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies.yaml)
  assert.deepEqual(runtime.parseYaml('answer: 42'), { answer: 42 })
})

test('without its package, Chrome integration switches itself off', () => {
  // The shipped build stubs @ant/* packages. A build with the real one is true here.
  assert.equal(runtime.isClaudeInChromeAvailable(), false)
  assert.equal(runtime.shouldEnableClaudeInChrome(true), false)
  // So a user's own server may use the name, instead of being sent to the stub.
  assert.equal(runtime.isClaudeInChromeMCPServer('claude-in-chrome'), false)
})

test('--chrome warns and carries on', { timeout: 120_000 }, async () => {
  // Stopped as soon as the warning appears, so no request ever goes out.
  const child = spawn(
    process.execPath,
    [join(repositoryRoot, 'dist', 'cli.mjs'), '--chrome', '-p', 'hello', '--no-session-persistence'],
    {
      cwd: project,
      env: { ...process.env, TAU_SKIP_PREFLIGHT: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  )
  let stderr = ''
  const warned = await new Promise(done => {
    const timer = setTimeout(() => done(false), 90_000)
    child.stderr.on('data', data => {
      stderr += data
      if (/Tau in Chrome is not available/.test(stderr)) {
        clearTimeout(timer)
        done(true)
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      done(/Tau in Chrome is not available/.test(stderr))
    })
  })
  child.kill()
  assert.ok(warned, `no warning. stderr: ${stderr.slice(0, 500)}`)
})

test('the bundle carries the slim mcpb entry, not its packing and signing CLI', () => {
  const bundle = readFileSync(bundlePath, 'utf8')
  assert.match(bundle, /node_modules\/@anthropic-ai\/mcpb\/dist\/browser\.js/)
  assert.doesNotMatch(bundle, /node_modules\/@anthropic-ai\/mcpb\/dist\/cli\//)
  assert.doesNotMatch(bundle, /import\("@anthropic-ai\/mcpb(\/browser)?"\)/)
})
