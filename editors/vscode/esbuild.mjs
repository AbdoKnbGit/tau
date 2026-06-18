/**
 * Bundles the Tau VS Code extension host into a single CJS file.
 *
 * Node's module resolution walks up the tree, so `esbuild` and
 * `@agentclientprotocol/sdk` resolve from the parent repo's node_modules — no
 * separate `npm install` is required in this folder. `vscode` is provided by
 * the editor at runtime and must stay external.
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src/extension.ts')],
  outfile: resolve(here, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  external: ['vscode'],
  // Resolve runtime deps (the ACP SDK) from the parent repo's node_modules.
  nodePaths: [resolve(here, '../../node_modules')],
  logLevel: 'info',
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[tau-vscode] watching…')
} else {
  await esbuild.build(options)
  console.log('[tau-vscode] built dist/extension.js')
}
