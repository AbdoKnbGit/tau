import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function source(relativePath) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8')
}

async function loadRustDecisionFunction() {
  const recommendationSource = source(
    'src/utils/plugins/lspRecommendation.ts',
  )
  const match = recommendationSource.match(
    /export function decideRustLspRecommendation[\s\S]*?\n}\n\n\/\*\*/,
  )
  assert.ok(match, 'Rust recommendation decision function should exist')

  const functionSource = match[0].replace(/\n\n\/\*\*$/, '')
  const compiled = await transform(
    `type LspRecommendationAction = 'install-plugin' | 'enable-plugin' | 'install-server'\n${functionSource}`,
    { loader: 'ts', format: 'esm' },
  )
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
  return (await import(moduleUrl)).decideRustLspRecommendation
}

test('Rust LSP recommendation distinguishes plugin, enable, and server setup', async () => {
  const decide = await loadRustDecisionFunction()

  assert.equal(
    decide({ installed: false, enabled: false, ready: false }),
    'install-plugin',
  )
  assert.equal(
    decide({ installed: true, enabled: false, ready: true }),
    'enable-plugin',
  )
  assert.equal(
    decide({ installed: true, enabled: true, ready: false }),
    'install-server',
  )
  assert.equal(
    decide({ installed: true, enabled: true, ready: true }),
    null,
  )
})

test('Rust LSP has one official owner and probes executable readiness', () => {
  const bundledPlugins = source('src/plugins/bundled/index.ts')
  const setup = source('src/services/lsp/rustAnalyzerSetup.ts')
  const lspConfig = source('src/services/lsp/config.ts')

  assert.doesNotMatch(bundledPlugins, /['"]rust-analyzer['"]\s*:/)
  assert.match(
    setup,
    /rust-analyzer-lsp@claude-plugins-official/,
  )
  assert.match(
    setup,
    /execFileNoThrowWithCwd\(commandPath, \['--version'\]/,
  )
  assert.match(setup, /\['component', 'add', 'rust-analyzer'\]/)
  assert.match(setup, /killTreeOnTimeout:\s*true/)
  assert.match(lspConfig, /Skipping unavailable Rust LSP server/)
})
