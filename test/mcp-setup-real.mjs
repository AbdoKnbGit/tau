// Opt-in real package tests. Usage from repo root:
// node test/mcp-setup-real.mjs <test-directory> [bundle-path]
// Installs only through package runners; all MCP configs/output stay in a fresh
// child directory. No model credentials or paid model calls are used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadMcpRuntime } from './helpers/mcp-built-runtime.mjs'

if (!process.argv[2]) throw new Error('Supply an existing test directory')
const cli = resolve(process.argv[3] ?? process.env.TAU_MCP_TEST_BUNDLE ?? 'dist/tau.mjs')
const root = mkdtempSync(join(resolve(process.argv[2]), 'tau-setup-real-'))
const project = join(root, 'project with spaces')
mkdirSync(project)
execFileSync('git', ['init', '--quiet', project], { windowsHide: true })
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.DISABLE_TELEMETRY = '1'
// Cold package downloads need more time than the fixture tests.
process.env.MCP_TIMEOUT = '120000'
process.env.TAU_MCP_TEST_BUNDLE = cli
const examples = [
  { name: 'js_browser', scope: 'user', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'], tool: 'browser_tabs', input: { action: 'list' } },
  { name: 'python_git', scope: 'project', command: 'uvx', args: ['mcp-server-git', '--repository', project], tool: 'git_status', input: { repo_path: project } },
  { name: 'js_memory', scope: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: join(root, 'memory.jsonl') }, tool: 'read_graph', input: {} },
]
console.log(`Evidence: ${root}`)
for (const example of examples) {
  const { command, args, env } = example
  execFileSync(process.execPath, [cli, 'mcp', 'add-json', example.name, '-s', example.scope,
    JSON.stringify({ type: 'stdio', command, args, ...(env && { env }) })], {
    cwd: project, env: process.env, timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
}
process.chdir(project)
const r = await loadMcpRuntime({ paths: ['src/services/mcp/config.ts'], exports: ['getMcpConfigByName'] })
const report = []
for (const example of examples) {
  const config = r.getMcpConfigByName(example.name)
  assert.equal(config.scope, example.scope)
  assert.equal(config.command, example.command)
  assert.deepEqual(config.args, example.args)
  const start = Date.now()
  const c = await r.connectToServer(example.name, config)
  const row = { name: example.name, scope: config.scope, command: config.command, args: config.args, status: c.type }
  report.push(row)
  try {
    assert.equal(c.type, 'connected', c.error)
    row.server = c.client.getServerVersion()
    const tools = await c.client.listTools()
    row.tools = tools.tools.map(t => t.name)
    assert.ok(row.tools.includes(example.tool), `missing ${example.tool}`)
    const result = await c.client.callTool({ name: example.tool, arguments: example.input })
    assert.notEqual(result.isError, true, JSON.stringify(result.content))
    row.testedTool = example.tool
    row.result = result.content
    console.log(`PASS ${example.name}: ${config.scope}, ${row.tools.length} tools, ${example.tool}`)
  } catch (error) {
    row.error = String(error)
    process.exitCode = 1
    console.log(`FAIL ${example.name}: ${row.error}`)
  } finally {
    if (c.type === 'connected') await c.cleanup()
    row.elapsedMs = Date.now() - start
    writeFileSync(join(root, 'results.json'), JSON.stringify(report, null, 2))
  }
}
