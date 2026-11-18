// The `archive` plugin source: digest pinning, root detection, staged
// extraction, download headers, and the download policy in the built CLI.
// The CLI tests need `node build.mjs` first.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { zipSync, unzipSync } = require('fflate')
const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'dist', 'cli.mjs')

const bundle = await build({
  entryPoints: [join(repoRoot, 'src/utils/plugins/archiveSource.ts')],
  bundle: true,
  packages: 'external',
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
})
const archive = (() => {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
    require,
    module,
    module.exports,
  )
  return module.exports
})()

const encode = text => new TextEncoder().encode(text)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// A plain extractor for the logic under test; production passes the zip
// cache's extractor, which adds the size, path and link checks.
async function extract(zipPath, targetDir) {
  const files = unzipSync(new Uint8Array(await readFile(zipPath)))
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('/')) continue
    const path = join(targetDir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'tau-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const manifest = encode(JSON.stringify({ name: 'fixture', version: '1.0.0' }))
const archiveAt = url => ({ source: 'archive', url })

test('a zip with the plugin at its top installs as is', async t => {
  const root = await scratch(t)
  const bytes = zipSync({
    '.claude-plugin/plugin.json': manifest,
    'skills/hello/SKILL.md': encode('---\nname: hello\n---\n'),
  })
  const target = join(root, 'plugin')
  const result = await archive.installArchiveBytes(
    bytes, archiveAt('https://example.com/p.zip'), target, extract,
  )
  assert.equal(result.sha256, sha256(bytes))
  assert.ok(existsSync(join(target, '.claude-plugin', 'plugin.json')))
  assert.ok(existsSync(join(target, 'skills', 'hello', 'SKILL.md')))
  assert.deepEqual(await readdir(root), ['plugin'], 'no staging left behind')
})

test('a zip with one enclosing directory installs that directory', async t => {
  const root = await scratch(t)
  const bytes = zipSync({
    'fixture-1.0.0/.claude-plugin/plugin.json': manifest,
    'fixture-1.0.0/commands/run.md': encode('Run.\n'),
    '__MACOSX/._fixture-1.0.0': encode('noise'),
  })
  const target = join(root, 'plugin')
  await archive.installArchiveBytes(
    bytes, archiveAt('https://example.com/p.zip'), target, extract,
  )
  assert.ok(existsSync(join(target, '.claude-plugin', 'plugin.json')))
  assert.ok(existsSync(join(target, 'commands', 'run.md')))
})

test('a pinned digest is checked in either letter case', async t => {
  const root = await scratch(t)
  const bytes = zipSync({ '.claude-plugin/plugin.json': manifest })
  const pinned = {
    ...archiveAt('https://example.com/p.zip'),
    sha256: sha256(bytes).toUpperCase(),
  }
  const result = await archive.installArchiveBytes(
    bytes, pinned, join(root, 'ok'), extract,
  )
  assert.equal(result.sha256, sha256(bytes))

  const wrong = { ...pinned, sha256: 'a'.repeat(64) }
  const target = join(root, 'refused')
  await assert.rejects(
    archive.installArchiveBytes(bytes, wrong, target, extract),
    /integrity check failed .* expected sha256 a{64}, got [0-9a-f]{64}/,
  )
  assert.equal(existsSync(target), false)
  assert.deepEqual(await readdir(root), ['ok'], 'no staging left behind')
})

test('a failed extraction leaves nothing behind', async t => {
  const root = await scratch(t)
  const bytes = zipSync({ '.claude-plugin/plugin.json': manifest })
  const target = join(root, 'plugin')
  await assert.rejects(
    archive.installArchiveBytes(
      bytes,
      archiveAt('https://example.com/p.zip'),
      target,
      async () => {
        throw new Error('Unsafe file path detected')
      },
    ),
    /Unsafe file path/,
  )
  assert.deepEqual(await readdir(root), [])
})

test('download headers: same-origin marketplace headers, entry overlay, routing names dropped', () => {
  const entry = {
    name: 'p',
    source: archiveAt('https://cdn.example.com/p.zip'),
    headers: {
      authorization: 'Bearer entry',
      Host: 'evil.example',
      'X-Forwarded-For': '1.2.3.4',
      'X-Team': 'docs',
    },
  }
  const sameOrigin = {
    source: 'url',
    url: 'https://cdn.example.com/marketplace.json',
    headers: { Authorization: 'Bearer marketplace', 'X-Org': 'acme' },
  }
  const { headers, dropped } = archive.resolveArchiveHeaders(entry, sameOrigin)
  assert.deepEqual(headers, {
    'X-Org': 'acme',
    authorization: 'Bearer entry',
    'X-Team': 'docs',
  })
  assert.deepEqual(dropped.sort(), ['Host', 'X-Forwarded-For'])

  const otherOrigin = { ...sameOrigin, url: 'https://catalog.example.com/m.json' }
  assert.deepEqual(archive.resolveArchiveHeaders(entry, otherOrigin).headers, {
    authorization: 'Bearer entry',
    'X-Team': 'docs',
  })

  const github = { name: 'g', source: { source: 'github', repo: 'o/r' }, headers: { A: 'b' } }
  assert.deepEqual(archive.resolveArchiveHeaders(github, sameOrigin).headers, {})

  assert.throws(
    () => archive.resolveArchiveHeaders({ ...entry, headersHelper: '/opt/mint' }, sameOrigin),
    /headersHelper command that was not run/,
  )

  // Helper output: the marketplace's over its static headers, the entry's
  // over its own static headers, and routing names dropped from either.
  const layered = archive.resolveArchiveHeaders(
    { ...entry, headersHelper: '/opt/mint' },
    sameOrigin,
    {
      marketplace: { Authorization: 'Bearer minted-marketplace', 'X-Org': 'acme' },
      entry: { Authorization: 'Bearer minted-entry', Cookie: 'session=1' },
    },
  )
  assert.equal(layered.headers.Authorization, 'Bearer minted-entry')
  assert.equal(layered.headers['X-Org'], 'acme')
  assert.equal('Cookie' in layered.headers, false)
})

// CLI: the catalog side of archive entries, with no network access needed.
async function sandbox(t) {
  const root = await scratch(t)
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_PLUGIN_CACHE_DIR: join(root, 'plugins'),
    CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
    CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_TELEMETRY: '1',
    NO_COLOR: '1',
  }
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT
  // A Windows session's markers make Tau treat piped stdin as a terminal.
  delete env.SESSIONNAME
  delete env.WT_SESSION
  // Must not reach a helper the catalog declares.
  env.ANTHROPIC_API_KEY = 'secret-for-test'
  const work = join(root, 'work')
  await mkdir(work, { recursive: true })
  async function tau(...args) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
        cwd: work, env, maxBuffer: 10 * 1024 * 1024, timeout: 60_000,
      })
      return { code: 0, output: stdout + stderr }
    } catch (error) {
      if (typeof error.code !== 'number') throw error
      return { code: error.code, output: `${error.stdout}${error.stderr}` }
    }
  }
  return { root, tau }
}

async function writeCatalog(root, plugins) {
  const path = join(root, 'marketplace', '.claude-plugin', 'marketplace.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    name: 'archive-fixture',
    owner: { name: 'Tau archive test' },
    description: 'Archive entries',
    plugins,
  }))
  return join(root, 'marketplace')
}

test('archive URLs on a local host are refused before any request', { timeout: 120_000 }, async t => {
  const box = await sandbox(t)
  const marketplace = await writeCatalog(box.root, [
    { name: 'local', source: archiveAt('https://127.0.0.1:9/p.zip') },
    { name: 'plain', source: archiveAt('http://example.com/p.zip') },
  ])
  assert.equal((await box.tau('plugin', 'marketplace', 'add', marketplace)).code, 0)

  const local = await box.tau('plugin', 'install', 'local@archive-fixture', '--scope', 'user')
  assert.notEqual(local.code, 0)
  assert.match(local.output, /must use HTTPS and a non-local destination/)

  // An http:// archive is not a valid entry; the rest of the catalog still loads.
  const plain = await box.tau('plugin', 'install', 'plain@archive-fixture', '--scope', 'user')
  assert.notEqual(plain.code, 0)
  assert.match(plain.output, /"plain" in marketplace "archive-fixture" can't be used/)
})

test('validate checks archive headers the way Claude Code does', { timeout: 120_000 }, async t => {
  const box = await sandbox(t)
  const marketplace = await writeCatalog(box.root, [
    {
      name: 'pinned',
      source: { ...archiveAt('https://cdn.example.com/p.zip'), sha256: 'A'.repeat(64) },
      headers: { Authorization: 'Bearer x', Host: 'evil.example' },
    },
    {
      name: 'helper-not-strict',
      source: archiveAt('https://cdn.example.com/q.zip'),
      headersHelper: '/opt/bin/mint',
    },
    {
      name: 'headers-on-git',
      source: { source: 'github', repo: 'owner/repo' },
      headers: { Authorization: 'Bearer x' },
    },
  ])
  const { output } = await box.tau('plugin', 'validate', marketplace)
  assert.match(output, /Header "Host" is a request-routing\/identity header/)
  assert.match(output, /"helper-not-strict" sets headersHelper but is not "strict": false/)
  assert.match(output, /"helper-not-strict" fetches its archive with a headersHelper but sets no sha256 pin/)
  assert.match(output, /"headers-on-git" sets headers\/headersHelper, which only apply to "archive" sources/)
  assert.doesNotMatch(output, /plugins\.0\.source: Invalid input/)
})

test('an entry headersHelper runs only once accepted, without credentials', { timeout: 180_000 }, async t => {
  const box = await sandbox(t)
  const marker = join(box.root, 'helper-ran.json')
  const helper = join(box.root, 'helper.mjs')
  await writeFile(helper, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({`,
    '  plugin: process.env.CLAUDE_CODE_PLUGIN_NAME,',
    '  url: process.env.CLAUDE_CODE_PLUGIN_ARCHIVE_URL,',
    "  sawApiKey: 'ANTHROPIC_API_KEY' in process.env,",
    '}))',
    "console.log(JSON.stringify({ Authorization: 'Bearer minted' }))",
    '',
  ].join('\n'))
  const marketplace = await writeCatalog(box.root, [{
    name: 'private',
    strict: false,
    source: archiveAt('https://127.0.0.1:9/private.zip'),
    headersHelper: `"${process.execPath}" "${helper}"`,
  }])
  assert.equal((await box.tau('plugin', 'marketplace', 'add', marketplace)).code, 0)

  const refused = await box.tau('plugin', 'install', 'private@archive-fixture')
  assert.notEqual(refused.code, 0)
  assert.match(refused.output, /downloads its archive with credentials printed by this command/)
  assert.match(refused.output, /SHA-256: [0-9a-f]{64}/)
  assert.equal(existsSync(marker), false, 'not run without consent')

  const accepted = await box.tau('plugin', 'install', 'private@archive-fixture', '--yes')
  assert.notEqual(accepted.code, 0, 'the local archive URL is still refused')
  assert.match(accepted.output, /must use HTTPS and a non-local destination/)
  const ran = JSON.parse(await readFile(marker, 'utf8'))
  assert.deepEqual(ran, {
    plugin: 'private',
    url: 'https://127.0.0.1:9/private.zip',
    sawApiKey: false,
  })
})
