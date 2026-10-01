import { readFile } from 'fs/promises'
import * as path from 'path'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { byDepth, listProjectFiles } from '../../utils/projectFiles.js'
import {
  suppressLSPDiagnosticsForFile,
  unsuppressLSPDiagnosticsForFile,
} from './LSPDiagnosticRegistry.js'
import { lspFileNameGlobs } from './fileKeys.js'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LSPServerManager } from './LSPServerManager.js'

// Bound the walk so startup never stalls on huge trees.
const PRIME_WALK_BUDGET_MS = 5_000
const primedServers = new WeakSet<LSPServerInstance>()

/**
 * Open one real project file per always-on server at session start so the
 * server begins loading its project graph immediately — servers only index
 * after a `didOpen`, so without this the indexing bar wouldn't appear until the
 * first LSP query. Fully best-effort and non-blocking; the primer file's
 * diagnostics are suppressed so this stays invisible to the model.
 */
export async function primeLspServers(
  manager: LSPServerManager,
): Promise<void> {
  const root = getCwd()

  // Which extension maps to which not-yet-primed always-on server.
  const extToServer = new Map<
    string,
    { name: string; server: LSPServerInstance }
  >()
  const pending = new Set<string>()
  for (const [name, server] of manager.getAllServers()) {
    if (!server.config.alwaysOn || primedServers.has(server)) continue
    const exts = Object.keys(server.config.extensionToLanguage)
    if (exts.length === 0) continue
    pending.add(name)
    for (const ext of exts) {
      const key = ext.toLowerCase()
      if (!extToServer.has(key)) extToServer.set(key, { name, server })
    }
  }
  if (pending.size === 0) return

  // One bounded walk of the project files its ignore files keep (hidden
  // folders skipped); prime each server with its shallowest file, which is
  // the most likely to belong to the root project.
  const files = await listProjectFiles(root, {
    hidden: 'files',
    names: lspFileNameGlobs(extToServer.keys()),
    signal: AbortSignal.timeout(PRIME_WALK_BUDGET_MS),
  })
  for (const file of files.sort(byDepth(root))) {
    const target = extToServer.get(path.extname(file).toLowerCase())
    if (!target || !pending.has(target.name)) continue
    pending.delete(target.name)
    void primeOne(manager, target.server, file)
    if (pending.size === 0) break
  }
}

async function primeOne(
  manager: LSPServerManager,
  server: LSPServerInstance,
  file: string,
): Promise<void> {
  // A plugin refresh/shutdown may have replaced this server during the walk.
  if (manager.getServerForFile(file) !== server || primedServers.has(server))
    return
  primedServers.add(server)
  const suppression = suppressLSPDiagnosticsForFile(file)
  try {
    const content = await readFile(file, 'utf-8')
    if (manager.getServerForFile(file) !== server) return
    await manager.openFile(file, content)
    logForDebugging(
      `[LSP PRIME] ${server.name}: opened ${file} to warm the project`,
    )
    // Once the project finishes loading (or the warmup times out), resume
    // normal diagnostics for that file so later real edits to it still report.
    await server.waitUntilReady()
  } catch (error) {
    logForDebugging(
      `[LSP PRIME] ${server.name} priming failed: ${String(error)}`,
    )
  } finally {
    setTimeout(() => unsuppressLSPDiagnosticsForFile(file, suppression), 3_000)
  }
}
