import { createHash } from 'crypto'
import { rmSync } from 'fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { registerCleanup } from '../cleanupRegistry.js'
import { downloadPluginArchive } from './marketplaceDownload.js'
import { extractZipToDirectory } from './zipCache.js'

const archives = new Map<string, Promise<string>>()
const downloads = new Map<string, Promise<string>>()
const directories = new Set<string>()
let cleanupRegistered = false

// Existing components can still refer to an older extraction after reload.
// Retain all generations until the session ends.
export function clearSessionPluginDownloads(): void {
  downloads.clear()
}

export async function cleanupSessionPluginArchives(): Promise<void> {
  await Promise.all(
    [...directories].map(async path => {
      await rm(path, { recursive: true, force: true })
      directories.delete(path)
    }),
  )
  archives.clear()
  downloads.clear()
}

async function extractArchive(bytes: Buffer): Promise<string> {
  const digest = createHash('sha256').update(bytes).digest('hex')
  let pending = archives.get(digest)
  if (!pending) {
    pending = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'tau-session-plugin-'))
      directories.add(directory)
      if (!cleanupRegistered) {
        registerCleanup(cleanupSessionPluginArchives)
        // Subcommands exit directly, without the interactive shutdown registry.
        // Only remove directories allocated by this process's mkdtemp calls.
        process.once('exit', () => {
          for (const path of directories) {
            try {
              rmSync(path, { recursive: true, force: true })
            } catch {
              /* Best effort at process exit. */
            }
          }
        })
        cleanupRegistered = true
      }
      try {
        const zip = join(directory, 'plugin.zip')
        const extracted = join(directory, 'contents')
        await writeFile(zip, bytes)
        await extractZipToDirectory(zip, extracted)
        await rm(zip)
        // Accept a conventional ZIP containing one enclosing plugin folder.
        const entries = await readdir(extracted, { withFileTypes: true })
        if (entries.length === 1 && entries[0]!.isDirectory()) {
          const child = join(extracted, entries[0]!.name)
          if (
            await stat(join(child, '.claude-plugin', 'plugin.json')).then(
              s => s.isFile(),
              () => false,
            )
          )
            return child
        }
        return extracted
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        directories.delete(directory)
        throw error
      }
    })()
    archives.set(digest, pending)
    pending.catch(() => archives.delete(digest))
  }
  return pending
}

export async function resolveSessionPluginPath(input: string): Promise<string> {
  if (/^https?:\/\//i.test(input)) {
    let pending = downloads.get(input)
    if (!pending) {
      pending = downloadPluginArchive(input).then(extractArchive)
      downloads.set(input, pending)
      pending.catch(() => downloads.delete(input))
    }
    return pending
  }
  const path = resolve(input)
  if (!path.toLowerCase().endsWith('.zip')) return path
  const info = await stat(path)
  if (!info.isFile()) return path
  if (info.size > 512 * 1024 * 1024)
    throw new Error('Plugin archive exceeds 512 MiB')
  return extractArchive(await readFile(path))
}
