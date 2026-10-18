// Explicit, opt-in live audit. Downloads plugins into disposable settings/cache
// directories; never starts their hooks or MCP servers. Build Tau first.
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'tau-live-plugin-audit-'))
const project = join(root, 'project')
await mkdir(project)
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'plugins'),
  CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
  CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS: '60000',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '',
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  NO_COLOR: '1',
}
const run = (...args) => exec(process.execPath, [join(repo, 'dist/cli.mjs'), ...args], {
  cwd: project, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
})
const followup = process.argv.includes('--followup')
const githubFixture = join(root, 'github-source-marketplace')
if (followup) {
  await mkdir(join(githubFixture, '.claude-plugin'), { recursive: true })
  await writeFile(join(githubFixture, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'github-source-audit', owner: { name: 'Tau audit' }, plugins: [{
      name: 'elements-of-style', source: { source: 'github', repo: 'obra/the-elements-of-style' },
    }],
  }))
}
const cases = followup ? [
  ['claude-mem', 'thedotmack'],
  ['elements-of-style', githubFixture],
] : [
  ['cc-stretch', 'https://github.com/pro-vi/cc-stretch'],
  ['superpowers', 'https://github.com/obra/superpowers-marketplace/'],
  ['elements-of-style', 'superpowers-marketplace'],
  ['document-skills', 'https://github.com/anthropics/skills'],
  ['claude-mem', 'https://github.com/thedotmack/claude-mem'],
  ['frontend-design', 'https://github.com/anthropics/claude-plugins-official'],
  ['context7', 'claude-plugins-official'],
  ['github', 'claude-plugins-official'],
  ['zilliz', 'claude-plugins-official'],
]
const results = []
try {
  for (const [plugin, marketplace] of cases) {
    console.log(`Auditing ${plugin} from ${marketplace}`)
    const started = Date.now()
    try {
      if (followup && plugin === 'claude-mem') {
        await run('plugin', 'marketplace', 'add', 'https://github.com/thedotmack/claude-mem', '--sparse', '.claude-plugin', 'plugin', 'cowork')
      }
      const { stdout } = await run('plugin', 'install', plugin, '--marketplace', marketplace)
      const installed = JSON.parse(await readFile(join(root, 'plugins', 'installed_plugins.json'), 'utf8'))
      const id = Object.keys(installed.plugins).find(id => id.startsWith(`${plugin}@`))
      const entry = installed.plugins[id]?.[0]
      results.push({ plugin, marketplace, status: 'installed', id, version: entry?.version,
        sha: entry?.gitCommitSha, message: stdout.trim().split('\n').at(-1), ms: Date.now() - started })
    } catch (error) {
      results.push({ plugin, marketplace, status: 'failed',
        error: [error.stdout, error.stderr, error.killed ? 'Process timed out' : ''].filter(Boolean).join('\n').trim().slice(-5000),
        ms: Date.now() - started })
    }
    console.log(JSON.stringify(results.at(-1)))
  }
  const listing = await run('plugin', 'list', '--json')
  const loaded = JSON.parse(listing.stdout)
  const report = { checkedAt: new Date().toISOString(), results, loaded }
  const output = join(repo, 'docs', followup ? 'plugin-marketplace-followup-audit.json' : 'plugin-marketplace-live-audit.json')
  // Do not persist runtime server configuration or disposable filesystem paths.
  await writeFile(output, JSON.stringify(report, (key, value) => {
    if (['installPath', 'projectPath', 'mcpServers'].includes(key)) return undefined
    return typeof value === 'string' ? value.replaceAll(root, '<temporary audit directory>') : value
  }, 2) + '\n')
  console.log(`Saved ${output}`)
  console.log(JSON.stringify(loaded, (key, value) => ['installPath', 'projectPath', 'mcpServers'].includes(key) ? undefined : value))
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
