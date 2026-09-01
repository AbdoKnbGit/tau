import { resolve } from 'path'

import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { PythonKernel } from './kernel.js'
import { ensureToolBridge } from './toolBridge.js'

/**
 * One kernel per (session, agent, cwd).
 *
 * Keyed by agent as well as session so a subagent never inherits the main
 * thread's namespace — two agents sharing a `df` variable would be a
 * spectacular source of confusion, and their cells interleave. Keyed by cwd
 * because the kernel chdir's at startup and puts cwd on sys.path.
 */

type Entry = { kernel: PythonKernel; sessionKey: string }

const kernels = new Map<string, Entry>()
let cleanupRegistered = false

function normalizeCwd(cwd: string): string {
  const resolved = resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function kernelKey(agentId: string | undefined, cwd: string): string {
  return `${getSessionId()}:${agentId ?? 'main'}:${normalizeCwd(cwd)}`
}

function ensureCleanupHook(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  registerCleanup(async () => {
    const entries = [...kernels.values()]
    kernels.clear()
    await Promise.all(
      entries.map(entry =>
        entry.kernel.shutdown().catch(() => {
          // A kernel that is already gone is the outcome we wanted; a kernel
          // that refuses to go is killed by shutdown()'s own escalation.
        }),
      ),
    )
  })
}

/**
 * Get the kernel for this key, starting or replacing it as needed.
 *
 * A dead subprocess is replaced transparently: the caller sees a working
 * kernel with an empty namespace rather than an error, which matches what the
 * model is told ("if the kernel gets into a bad state, state is gone").
 */
export async function acquireKernel(options: {
  agentId: string | undefined
  cwd: string
  reset: boolean
}): Promise<{ kernel: PythonKernel; sessionKey: string; restarted: boolean }> {
  ensureCleanupHook()
  const key = kernelKey(options.agentId, options.cwd)
  const existing = kernels.get(key)

  if (existing && existing.kernel.isAlive()) {
    if (options.reset) {
      await existing.kernel.reset()
      return { ...existing, restarted: true }
    }
    return { ...existing, restarted: false }
  }

  if (existing) {
    logForDebugging(`Eval: replacing dead kernel for ${key}`)
    await existing.kernel.shutdown().catch(() => {})
    kernels.delete(key)
  }

  const bridge = await ensureToolBridge()
  const sessionKey = key
  const kernel = new PythonKernel({
    cwd: options.cwd,
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    bridgeSession: sessionKey,
  })
  await kernel.start()
  const entry = { kernel, sessionKey }
  kernels.set(key, entry)
  return { ...entry, restarted: existing !== undefined }
}

/** Drop a kernel that reported itself unusable so the next call starts clean. */
export function discardKernel(agentId: string | undefined, cwd: string): void {
  const key = kernelKey(agentId, cwd)
  const entry = kernels.get(key)
  if (!entry) return
  kernels.delete(key)
  void entry.kernel.shutdown().catch(() => {})
}

/** Test helper: tear every kernel down without going through cleanup. */
export async function __disposeAllKernelsForTests(): Promise<void> {
  const entries = [...kernels.values()]
  kernels.clear()
  await Promise.all(entries.map(entry => entry.kernel.shutdown().catch(() => {})))
}
