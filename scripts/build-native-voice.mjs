#!/usr/bin/env node

// Release builders compile once per target. End users receive the .node binary.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'tau-voice')
const triples = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
}
const platform = process.env.TAU_VOICE_PLATFORM || process.platform
const arch = process.env.TAU_VOICE_ARCH || process.arch
const target = process.env.TAU_VOICE_TARGET || triples[`${platform}-${arch}`]
if (!target) throw new Error(`No native voice build target for ${platform}-${arch}`)
const output = join(source, 'bin', `tau_voice.${platform}-${arch}.node`)
const env = { ...process.env }
// Upstream static Opus declares a pre-3.5 policy baseline. CMake 4 requires
// an explicit compatibility floor when building this unchanged codec source.
env.CMAKE_POLICY_VERSION_MINIMUM ||= '3.5'
const localCmake = join(source, '.tools', 'cmake', 'data', 'bin', 'cmake.exe')
if (process.platform === 'win32' && !env.CMAKE && existsSync(localCmake)) {
  env.CMAKE = localCmake
}
const result = spawnSync('cargo', ['build', '--locked', '--release', '--target', target], {
  cwd: source, env, stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const library = platform === 'win32' ? 'tau_voice.dll'
  : platform === 'darwin' ? 'libtau_voice.dylib' : 'libtau_voice.so'
const targetDir = resolve(source, process.env.CARGO_TARGET_DIR || 'target')
mkdirSync(dirname(output), { recursive: true })
copyFileSync(join(targetDir, target, 'release', library), output)
process.stdout.write(`Built native Tau voice ${output}\n`)
