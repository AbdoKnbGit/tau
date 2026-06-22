import { readFile, readdir } from 'fs/promises'
import * as path from 'path'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  suppressLSPDiagnosticsForFile,
  unsuppressLSPDiagnosticsForFile,
} from './LSPDiagnosticRegistry.js'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'

// Directories never worth walking when looking for a primer file.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  '.cache',
  'tmp',
  '.venv',
  'venv',
  '__pycache__',
])
// Bound the walk so startup never stalls on huge trees.
const MAX_ENTRIES = 4000

/**
 * Open one real project file per always-on server at session start so the
 * server begins loading its project graph immediately — servers only index
 * after a `didOpen`, so without this the indexing bar wouldn't appear until the
 * first LSP query. Fully best-effort and non-blocking; the primer file's
 * diagnostics are suppressed so this stays invisible to the model.
 */
export async function primeLspServers(manager: LSPServerManager): Promise<void> {
  const root = getCwd()

  // Which extension maps to which not-yet-primed always-on server.
  const extToServer = new Map<
    string,
    { name: string; server: LSPServerInstance }
  >()
  const pending = new Set<string>()
  for (const [name, server] of manager.getAllServers()) {
    if (!server.config.alwaysOn) continue
    const exts = Object.keys(server.config.extensionToLanguage)
    if (exts.length === 0) continue
    pending.add(name)
    for (const ext of exts) {
      const key = ext.toLowerCase()
      if (!extToServer.has(key)) extToServer.set(key, { name, server })
    }
  }
  if (pending.size === 0) return

  // Single bounded breadth-first walk; prime each server with the first file
  // matching one of its extensions, and stop once every server is primed.
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < MAX_ENTRIES && pending.size > 0) {
    const dir = queue.shift()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) break
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push(path.join(dir, entry.name))
        }
        continue
      }
      if (!entry.isFile()) continue
      const target = extToServer.get(path.extname(entry.name).toLowerCase())
      if (!target || !pending.has(target.name)) continue
      pending.delete(target.name)
      void primeOne(manager, target.server, path.join(dir, entry.name))
      if (pending.size === 0) break
    }
  }
}

async function primeOne(
  manager: LSPServerManager,
  server: LSPServerInstance,
  file: string,
): Promise<void> {
  try {
    suppressLSPDiagnosticsForFile(file)
    const content = await readFile(file, 'utf-8')
    await manager.openFile(file, content)
    logForDebugging(
      `[LSP PRIME] ${server.name}: opened ${file} to warm the project`,
    )
    // Once the project finishes loading (or the warmup times out), resume
    // normal diagnostics for that file so later real edits to it still report.
    await server.waitUntilReady()
    setTimeout(() => unsuppressLSPDiagnosticsForFile(file), 3_000)
  } catch (error) {
    logForDebugging(`[LSP PRIME] ${server.name} priming failed: ${String(error)}`)
  }
}
