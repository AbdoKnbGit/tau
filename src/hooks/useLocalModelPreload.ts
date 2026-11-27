import { useEffect, useRef } from 'react'
import { isLocalModelRequest } from '../lanes/openai-compat/local_model_settings.js'
import { getMcpLaunchBudgetMs, isMcpLaunchBarrierArmed } from '../services/mcp/launchBarrier.js'
import { isMcpDiscoverySettled, waitForMcpDiscovery } from '../services/mcp/readiness.js'
import { logForDebugging } from '../utils/debug.js'
import { launchElapsedMs } from '../utils/launchClock.js'
import { localPreloadEnabled } from '../utils/model/localModelPreload.js'
import { getAPIProvider } from '../utils/model/providers.js'

/**
 * Loads this session's prompt into a local model while the user types
 * (utils/model/localModelPreload.ts): once per model, after startup MCP
 * discovery settles, and only while no request runs. Idle for every model
 * that is not on a local server.
 */
export function useLocalModelPreload({
  mainLoopModel,
  isBusy,
  preload,
}: {
  mainLoopModel: string
  isBusy: () => boolean
  /** Sends the preload: the first turn's own prompt, through the normal pipeline. */
  preload: (model: string, signal: AbortSignal) => Promise<void>
}): void {
  const preloaded = useRef(new Set<string>())
  const latest = useRef({ isBusy, preload })
  latest.current = { isBusy, preload }

  useEffect(() => {
    if (!mainLoopModel || !localPreloadEnabled()) return
    const provider = getAPIProvider()
    // The lane's own rule: Ollama's models on this machine, LM Studio, and
    // any server that stands behind LM Studio's address.
    if (!isLocalModelRequest(provider, mainLoopModel, false)) return
    const key = `${provider}\n${mainLoopModel}`
    if (preloaded.current.has(key)) return
    preloaded.current.add(key)
    const controller = new AbortController()
    void (async () => {
      await waitForStartupMcp(controller.signal)
      if (controller.signal.aborted || latest.current.isBusy()) return
      await latest.current.preload(mainLoopModel, controller.signal)
    })().catch(error => logForDebugging(`[local preload] ${mainLoopModel}: ${String(error)}`))
    return () => controller.abort()
  }, [mainLoopModel])
}

/**
 * The first turn waits for startup MCP discovery, so it carries every tool
 * (services/mcp/launchBarrier.ts). The preload waits the same way without
 * taking the barrier, so a message sent meanwhile still waits for it.
 */
async function waitForStartupMcp(signal: AbortSignal): Promise<void> {
  if (!isMcpLaunchBarrierArmed() || isMcpDiscoverySettled()) return
  const remaining = getMcpLaunchBudgetMs() - launchElapsedMs()
  if (remaining > 0) await waitForMcpDiscovery(remaining, signal)
}
