import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const NATIVE_VOICE_TARGETS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']

/** Only Linux needs the runtime libc, and getReport() is synchronous: it walks
 * every handle, loaded module and thread stack, so it blocks the event loop for
 * as long as that takes. As a default argument it ran on every call and every
 * platform, then went unused off Linux. Detect lazily, once, and never on
 * Windows or macOS. */
let hostGlibc
function runtimeGlibc(platform) {
  if (platform !== 'linux') return ''
  hostGlibc ??= process.report?.getReport()?.header?.glibcVersionRuntime ?? ''
  return hostGlibc
}
export function nativeVoiceTarget(platform = process.platform, arch = process.arch, glibc) {
  const target = `${platform}-${arch}`
  // An explicitly passed value wins, including '' for "this host has no glibc".
  const libc = glibc ?? runtimeGlibc(platform)
  if (!NATIVE_VOICE_TARGETS.includes(target) || (platform === 'linux' && !libc)) {
    throw new Error(`Tau voice does not yet support ${target}${platform === 'linux' && !libc ? ' (musl)' : ''}. Use Windows, macOS, or glibc Linux on x64/arm64.`)
  }
  return target
}
export const voicePackageNameFor = target => `@abdoknbgit/tau-voice-${target}`

/**
 * Where this host's addon lives.
 *
 * A published install gets it from the per-platform optional dependency, so
 * only the matching binary is ever downloaded. A source checkout, and the
 * release staging that builds those packages, keeps all six under
 * `native/tau-voice/bin`. Both layouts carry a manifest next to the binary, so
 * the integrity check downstream is identical either way.
 */
export function resolveNativeVoiceArtifact(packageRoot, target, options = {}) {
  const file = `tau_voice.${target}.node`
  const require_ = options.require ?? createRequire(join(packageRoot, 'package.json'))
  try {
    const packaged = require_.resolve(`${voicePackageNameFor(target)}/${file}`)
    if (existsSync(packaged)) return { path: packaged, directory: dirname(packaged), file, packaged: true }
  } catch { /* Not installed: fall through to the release directory. */ }
  const directory = join(packageRoot, 'native', 'tau-voice', 'bin')
  return { path: join(directory, file), directory, file, packaged: false }
}

export function verifyNativeVoice(packageRoot, options = {}) {
  const target = options.target ?? nativeVoiceTarget()
  if (!NATIVE_VOICE_TARGETS.includes(target)) throw new Error(`Unsupported voice target: ${target}`)
  const { path, directory, file } = resolveNativeVoiceArtifact(packageRoot, target, options)
  if (!existsSync(path)) throw new Error(`Tau's audio component for ${target} is missing. Reinstall or update Tau; if npm skipped the optional ${voicePackageNameFor(target)} package, reinstall with a working network. Source builds: npm run build:native-voice.`)
  const content = readFileSync(path)
  const hash = createHash('sha256').update(content).digest('hex')
  const manifestPath = join(directory, 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const artifact = manifest.artifacts?.[file]
    if (manifest.voiceAbiVersion !== 1 || manifest.napiVersion !== 8 || artifact?.sha256 !== hash || artifact?.size !== content.length) throw new Error(`Tau audio integrity check failed (${target}). Reinstall Tau.`)
  } else if (!existsSync(join(packageRoot, '.git'))) {
    throw new Error('Tau audio manifest is missing. Reinstall Tau.')
  }
  return { path, hash, target, file }
}

/** Windows locks loaded DLLs. Stage by content hash so npm can replace Tau. */
export function nativeVoiceLoadPath(packageRoot, options = {}) {
  const artifact = verifyNativeVoice(packageRoot, options)
  if ((options.platform ?? process.platform) !== 'win32') return artifact.path
  const directory = join(options.cacheRoot ?? join(homedir(), '.cache', 'tau', 'voice'), artifact.hash)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const staged = join(directory, artifact.file)
  try { copyFileSync(artifact.path, staged, constants.COPYFILE_EXCL) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (createHash('sha256').update(readFileSync(staged)).digest('hex') !== artifact.hash) throw new Error('Cached Tau audio failed its integrity check. Remove the Tau voice cache and retry.')
  }
  return staged
}
