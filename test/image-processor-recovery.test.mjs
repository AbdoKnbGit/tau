import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const sharpEntry = require.resolve('sharp')
const realSharp = require(sharpEntry)

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'tau-image-loader-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  const packageRoot = join(root, 'shared Tau package')
  const sharpRoot = join(packageRoot, 'node_modules/sharp')
  const cacheRoot = join(root, 'image cache')
  await mkdir(sharpRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@abdoknbgit/tau', version: '0.0.0' }))
  await writeFile(join(sharpRoot, 'package.json'), JSON.stringify({ name: 'sharp', version: realSharp.versions.sharp, main: 'index.cjs' }))
  const proxy = `module.exports = require(${JSON.stringify(sharpEntry)});\n`
  const installedSource = mode === 'healthy' ? proxy : 'throw new Error("fixture Windows decoder cannot load under this runtime");\n'
  await writeFile(join(sharpRoot, 'index.cjs'), installedSource)

  const helper = `
    import { ensureImageRuntime as ensureReal } from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/image-runtime.mjs')).href)};
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export const state = { calls: 0, installs: 0, roots: [] };
    export const findImagePackageRoot = () => ${JSON.stringify(packageRoot)};
    export async function ensureImageRuntime(packageRoot) {
      state.calls++; state.roots.push(packageRoot);
      return ensureReal(packageRoot, {
        cacheRoot: ${JSON.stringify(cacheRoot)}, probeTimeoutMs: 10_000,
        install: async (staging, version) => {
          state.installs++;
          if (${JSON.stringify(mode)} === 'offline') throw new Error('fixture offline');
          const target = join(staging, 'node_modules/sharp');
          await mkdir(target, {recursive:true});
          await writeFile(join(target, 'package.json'), JSON.stringify({name:'sharp',version,main:'index.cjs'}));
          await writeFile(join(target, 'index.cjs'), ${JSON.stringify(proxy)});
        }
      });
    }
  `
  const helperPath = join(root, 'helper.mjs')
  const bundledPath = join(root, 'bundled.mjs')
  await writeFile(helperPath, helper)
  await writeFile(bundledPath, 'export const isInBundledMode = () => false;\n')
  // Transpile the production loader with the existing pure-JS TypeScript
  // dependency, so a shared Windows/WSL checkout does not need a second native
  // compiler binary just to run these image-recovery integration tests.
  let source = await readFile(join(repository, 'src/tools/FileReadTool/imageProcessor.ts'), 'utf8')
  const helperImport = "'../../../scripts/image-runtime.mjs'"
  const bundledImport = "'../../utils/bundledMode.js'"
  assert.ok(source.includes(helperImport) && source.includes(bundledImport))
  source = source.replace(helperImport, JSON.stringify(pathToFileURL(helperPath).href))
    .replace(bundledImport, JSON.stringify(pathToFileURL(bundledPath).href))
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loader = join(root, 'loader.mjs')
  await writeFile(loader, compiled + `\nexport { state } from ${JSON.stringify(pathToFileURL(helperPath).href)};\n`)
  return { runtime: await import(pathToFileURL(loader).href), packageRoot, installedSource, sharpRoot }
}

for (const mode of ['healthy', 'repaired']) {
  test(`concurrent image readers and creators share the ${mode} verified Sharp function`, async t => {
    const f = await fixture(t, mode)
    const r = f.runtime
    assert.equal(r.getImageProcessorFailureHint(), null)
    const processors = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      index % 2 ? r.getImageCreator() : r.getImageProcessor()))
    assert.ok(processors.every(processor => processor === processors[0]))
    assert.equal(processors[0], realSharp)
    assert.equal(r.state.calls, 1)
    assert.equal(r.state.installs, mode === 'healthy' ? 0 : 1)
    assert.deepEqual(r.state.roots, [f.packageRoot])
    const png = await processors[0]({ create: { width: 2, height: 3, channels: 4, background: '#d75f00' } }).png().toBuffer()
    const decoded = await processors[0](png).metadata()
    assert.equal(decoded.width, 2)
    assert.equal(decoded.height, 3)
    assert.equal(r.getImageProcessorFailureHint(), null)
    assert.equal(await readFile(join(f.sharpRoot, 'index.cjs'), 'utf8'), f.installedSource, 'recovery must not replace the shared package decoder')
  })
}

test('an unavailable decoder gives one stable failure hint and one recovery attempt across all image paths', async t => {
  const { runtime: r } = await fixture(t, 'offline')
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    index % 2 ? r.getImageCreator() : r.getImageProcessor()))
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.match(results[0].reason.message, /Image decoding is unavailable/)
  const hint = r.getImageProcessorFailureHint()
  assert.match(hint, /Image preview unavailable/)
  assert.equal(r.state.calls, 1)
  assert.equal(r.state.installs, 1)
  await assert.rejects(r.getImageCreator(), /Image decoding is unavailable/)
  await assert.rejects(r.getImageProcessor(), /Image decoding is unavailable/)
  assert.equal(r.state.calls, 1)
  assert.equal(r.state.installs, 1)
  assert.equal(r.getImageProcessorFailureHint(), hint)
})
