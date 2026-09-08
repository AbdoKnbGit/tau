import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const NATIVE_VOICE_TARGETS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']
export function nativeVoiceTarget(platform = process.platform, arch = process.arch, glibc = process.report?.getReport()?.header?.glibcVersionRuntime) {
  const target = `${platform}-${arch}`
  if (!NATIVE_VOICE_TARGETS.includes(target) || (platform === 'linux' && !glibc)) {
    throw new Error(`Tau voice does not yet support ${target}${platform === 'linux' && !glibc ? ' (musl)' : ''}. Use Windows, macOS, or glibc Linux on x64/arm64.`)
  }
  return target
}
export function verifyNativeVoice(packageRoot, options = {}) {
  const target = options.target ?? nativeVoiceTarget()
  if (!NATIVE_VOICE_TARGETS.includes(target)) throw new Error(`Unsupported voice target: ${target}`)
  const file = `tau_voice.${target}.node`
  const directory = join(packageRoot, 'native', 'tau-voice', 'bin')
  const path = join(directory, file)
  if (!existsSync(path)) throw new Error(`Tau's bundled audio component is missing (${target}). Reinstall or update Tau. Source builds: npm run build:native-voice.`)
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
