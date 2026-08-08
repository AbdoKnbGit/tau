import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(repoRoot, 'dist', 'cli.mjs')

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n')
    error.message += output ? `\n${output}` : ''
    throw error
  }
}

async function git(repo, ...args) {
  return run('git', ['-C', repo, ...args])
}

async function initRepository(repo) {
  await mkdir(repo, { recursive: true })
  await run('git', ['init', repo])
  await git(repo, 'config', 'user.name', 'Tau integration test')
  await git(repo, 'config', 'user.email', 'tau-test@example.invalid')
}

async function commitAll(repo, message) {
  await git(repo, 'add', '--all')
  await git(repo, 'commit', '-m', message)
  return (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function publishPluginVersion(repo, version) {
  await writeJson(join(repo, '.claude-plugin', 'plugin.json'), {
    name: 'refresh-fixture-plugin',
    description: 'Local integration fixture for marketplace refreshes',
    version,
  })
  await writeFile(join(repo, 'payload.txt'), `plugin payload ${version}\n`, 'utf8')
  return commitAll(repo, `plugin ${version}`)
}

async function publishMarketplace(repo, pluginUrl, sha) {
  await writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
    name: 'refresh-fixture',
    owner: { name: 'Tau integration test' },
    plugins: [
      {
        name: 'refresh-fixture-plugin',
        description: 'Local integration fixture for marketplace refreshes',
        source: { source: 'url', url: pluginUrl, sha },
      },
    ],
  })
  return commitAll(repo, `marketplace pins ${sha}`)
}

test(
  'plugin update refreshes a stale Git marketplace and preserves its SHA boundary',
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-plugin-update-'))

    try {
      const pluginRepo = join(root, 'plugin-repository')
      const marketplaceRepo = join(root, 'marketplace-repository')
      const configDir = join(root, 'config')
      const pluginsDir = join(root, 'plugin-cache')
      const marketplaceClone = join(
        pluginsDir,
        'marketplaces',
        'refresh-fixture',
      )

      await initRepository(pluginRepo)
      const pluginV1Sha = await publishPluginVersion(pluginRepo, '1.0.0')
      const pluginUrl = pathToFileURL(pluginRepo).href

      await initRepository(marketplaceRepo)
      await publishMarketplace(marketplaceRepo, pluginUrl, pluginV1Sha)
      const marketplaceUrl = pathToFileURL(marketplaceRepo).href

      await mkdir(dirname(marketplaceClone), { recursive: true })
      await run('git', ['clone', marketplaceUrl, marketplaceClone])
      await writeJson(join(pluginsDir, 'known_marketplaces.json'), {
        'refresh-fixture': {
          source: { source: 'git', url: marketplaceUrl },
          installLocation: marketplaceClone,
          lastUpdated: '1970-01-01T00:00:00.000Z',
        },
      })
      await writeJson(join(configDir, 'settings.json'), {
        extraKnownMarketplaces: {
          'refresh-fixture': {
            source: { source: 'git', url: marketplaceUrl },
          },
        },
      })

      const env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsDir,
        CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: '0',
        CLAUDE_CODE_USE_COWORK_PLUGINS: '0',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_TELEMETRY: '1',
        NO_COLOR: '1',
      }

      await run(
        process.execPath,
        [
          cliPath,
          'plugin',
          'install',
          'refresh-fixture-plugin@refresh-fixture',
          '--scope',
          'user',
        ],
        { env },
      )

      const pluginV2Sha = await publishPluginVersion(pluginRepo, '2.0.0')
      await publishMarketplace(marketplaceRepo, pluginUrl, pluginV2Sha)

      const updated = await run(
        process.execPath,
        [
          cliPath,
          'plugin',
          'update',
          'refresh-fixture-plugin',
          '--scope',
          'user',
        ],
        { env },
      )
      assert.match(updated.stdout, /updated from 1\.0\.0 to 2\.0\.0/)

      const installedPath = join(pluginsDir, 'installed_plugins.json')
      const installed = JSON.parse(await readFile(installedPath, 'utf8'))
      const installation =
        installed.plugins['refresh-fixture-plugin@refresh-fixture'][0]
      assert.equal(installation.version, '2.0.0')

      // A commit in the plugin repository is not itself a published update.
      // The marketplace still pins v2, so explicit update must not chase HEAD.
      await publishPluginVersion(pluginRepo, '3.0.0')
      const pinned = await run(
        process.execPath,
        [
          cliPath,
          'plugin',
          'update',
          'refresh-fixture-plugin',
          '--scope',
          'user',
        ],
        { env },
      )
      assert.match(pinned.stdout, /already at the latest version \(2\.0\.0\)/)

      const stillInstalled = JSON.parse(await readFile(installedPath, 'utf8'))
      assert.equal(
        stillInstalled.plugins['refresh-fixture-plugin@refresh-fixture'][0]
          .version,
        '2.0.0',
      )

      // If the catalog cannot be refreshed, the cached definition remains
      // usable and the result explicitly says its version may be stale.
      await rename(marketplaceRepo, `${marketplaceRepo}-offline`)
      await writeJson(join(pluginsDir, 'known_marketplaces.json'), {
        'refresh-fixture': {
          source: { source: 'git', url: marketplaceUrl },
          installLocation: marketplaceClone,
          lastUpdated: '1970-01-01T00:00:00.000Z',
        },
      })
      const offline = await run(
        process.execPath,
        [
          cliPath,
          'plugin',
          'update',
          'refresh-fixture-plugin',
          '--scope',
          'user',
        ],
        { env },
      )
      assert.match(offline.stdout, /marketplace not refreshed/)
      assert.match(offline.stdout, /version shown may be stale/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
