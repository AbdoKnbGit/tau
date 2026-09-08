import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const target = `${process.platform}-${process.arch}`
const file = `tau_voice.${target}.node`
const addon = resolve('native/tau-voice/bin', file)

test('real voice postinstall verifies bundled audio without Rust, external executables, or model downloads', { skip: !existsSync(addon) }, t => {
  const root = mkdtempSync(join(tmpdir(), 'tau-voice-postinstall-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(resolve('scripts'), join(root, 'scripts'), { recursive: true })
  // Isolate the unrelated ripgrep prerequisite; the audio installer, manifest,
  // ABI load, and lifecycle marker are the actual production implementations.
  cpSync(join(root, 'scripts/platform-support.mjs'), join(root, 'scripts/platform-support-real.mjs'))
  writeFileSync(join(root, 'scripts/platform-support.mjs'), `export * from './platform-support-real.mjs'; export const isUsableRipgrepCommand = () => true;`)
  const rgDir = join(root, 'dist/vendor/ripgrep', `${process.arch}-${process.platform === 'win32' ? 'win32' : process.platform}`)
  mkdirSync(rgDir, { recursive: true })
  writeFileSync(join(rgDir, process.platform === 'win32' ? 'rg.exe' : 'rg'), 'isolated prerequisite')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@abdoknbgit/tau', version: '0.92.29', type: 'module', dependencies: {} }))
  const bin = join(root, 'native/tau-voice/bin')
  mkdirSync(bin, { recursive: true })
  cpSync(addon, join(bin, file))
  const data = readFileSync(addon)
  writeFileSync(join(bin, 'manifest.json'), JSON.stringify({ version: 1, voiceAbiVersion: 1, napiVersion: 8, artifacts: { [file]: { size: data.length, sha256: createHash('sha256').update(data).digest('hex') } } }))
  const env = { ...process.env, TAU_REPAIR: '1', TAU_SKIP_NATIVE_TOOLS_POSTINSTALL: '1', TAU_SKIP_OLLAMA_PREPULL: '1' }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = ''
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/postinstall.mjs')], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true })
  const installed = run()
  assert.equal(installed.status, 0, installed.error?.message ?? installed.stderr)
  assert.match(installed.stdout, /Native voice ready/)
  assert.ok(existsSync(join(root, '.tau-lifecycle-complete.json')))
  // A broken same-version update must invalidate the old completion marker.
  writeFileSync(join(bin, file), 'corrupted update')
  const corrupted = run()
  assert.notEqual(corrupted.status, 0)
  assert.match(corrupted.stderr, /audio integrity check failed/)
  assert.ok(!existsSync(join(root, '.tau-lifecycle-complete.json')))
})
