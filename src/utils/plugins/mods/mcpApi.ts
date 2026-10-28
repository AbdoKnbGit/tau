import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LoadedPlugin } from '../../../types/plugin.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../../services/mcp/types.js'
import {
  connectToServer,
  getServerCacheKey,
  getMcpToolsCommandsAndResources,
  getMcpToolTimeoutMs,
  fetchToolsForClient,
} from '../../../services/mcp/client.js'
import {
  doesEnterpriseMcpConfigExist,
  filterMcpServersByPolicy,
  getClaudeCodeMcpConfigs,
  getMcpServerSignature,
  isMcpServerDisabled,
} from '../../../services/mcp/config.js'
import { normalizeNameForMCP } from '../../../services/mcp/normalization.js'
import {
  getProjectMcpServerStatus,
  hashMcpConfig,
} from '../../../services/mcp/utils.js'
import {
  getModMcpSessionOptions,
  publishModMcpUpdate,
  applyModMcpUpdate,
  type ModMcpUpdate,
} from '../../../services/mcp/modSession.js'
import {
  getPluginMcpServers,
  loadPluginMcpServers,
} from '../mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../pluginLoader.js'
import { getModToolContext, readModToolSnapshot } from './toolContext.js'
import { getPowerModeFromSettings } from '../../powerMode.js'
import { getInitialSettings } from '../../settings/settings.js'
import { isBareMode } from '../../envUtils.js'
import {
  acknowledgeMcpPublication,
  registerMcpPublisher,
} from '../../../services/mcp/readiness.js'

type Refusal =
  'unlisted' | 'unapproved' | 'disabled' | 'policy' | 'auth' | 'failed'
const refuse = (reason: Refusal, message: string) => ({
  isConnected: false as const,
  reason,
  message,
})

function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error(`${label} must be a nonempty name`)
  return value
}

export function mcpApiInput(
  method: string,
  args: unknown[],
): { server: string; tool?: string; args?: Record<string, unknown> } {
  const server = name(args[0], `${method} server`)
  if (method === 'mcp.connect') {
    if (args.length !== 1) throw new Error('mcp.connect takes one server name')
    return { server }
  }
  const tool = name(args[1], 'mcp.call tool')
  const input = args[2]
  if (
    args.length > 3 ||
    (input !== undefined &&
      (!input || typeof input !== 'object' || Array.isArray(input)))
  )
    throw new Error('mcp.call takes server, tool, and optional argument object')
  return {
    server,
    tool,
    ...(input === undefined ? {} : { args: input as Record<string, unknown> }),
  }
}

/** Do not cancel shared discovery when only one waiting mod was unloaded. */
function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('Mod MCP call aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

function runtimeDisabled(): boolean {
  return (
    isBareMode() || getPowerModeFromSettings(getInitialSettings()) === 'cheap'
  )
}

async function effectiveConfigs(
  clients?: MCPServerConnection[],
): Promise<Record<string, ScopedMcpServerConfig>> {
  const options = getModMcpSessionOptions()
  const context = getModToolContext()?.toolUseContext
  const live =
    clients ?? (context ? readModToolSnapshot(context).mcpClients : [])
  const dynamic = {
    ...(context?.options.dynamicMcpConfig ?? options.dynamic),
    ...Object.fromEntries(
      live
        .filter(
          client =>
            client.config.scope === 'dynamic' && !client.config.pluginSource,
        )
        .map(client => [client.name, client.config]),
    ),
  }
  const configured = options.strict
    ? {}
    : (await getClaudeCodeMcpConfigs(dynamic)).servers
  return filterMcpServersByPolicy({ ...configured, ...dynamic }).allowed
}

function refusalFor(name: string, config: ScopedMcpServerConfig) {
  if (runtimeDisabled() || isMcpServerDisabled(name))
    return refuse('disabled', `MCP server ${name} is disabled in this session.`)
  if (!filterMcpServersByPolicy({ [name]: config }).allowed[name])
    return refuse('policy', `MCP server ${name} is blocked by policy.`)
  if (
    config.type !== 'sdk' &&
    config.scope === 'project' &&
    getProjectMcpServerStatus(name) !== 'approved'
  )
    return refuse('unapproved', `MCP server ${name} needs project approval.`)
}

async function cachedClient(
  name: string,
  config: ScopedMcpServerConfig,
  signal: AbortSignal,
) {
  const key = getServerCacheKey(name, config)
  const pending = connectToServer.cache.get(key) as
    Promise<MCPServerConnection> | undefined
  if (!pending) return undefined
  const client = await waitFor(pending, signal)
  return connectToServer.cache.get(key) === pending ? client : undefined
}

function publish(update: ModMcpUpdate, isCurrent: () => boolean): void {
  if (publishModMcpUpdate(update, isCurrent)) return
  // Embedded hosts may supply a tool context without the CLI's publisher.
  const context = getModToolContext()?.toolUseContext
  if (context)
    context.setAppState(previous => {
      const next = !isCurrent()
        ? previous
        : {
            ...previous,
            mcp: applyModMcpUpdate(previous.mcp, update),
          }
      acknowledgeMcpPublication(update.client.name)
      return next
    })
  else acknowledgeMcpPublication(update.client.name)
}

async function connect(
  plugin: LoadedPlugin,
  server: string,
  signal: AbortSignal,
) {
  const listed = plugin.mcpServers ?? (await loadPluginMcpServers(plugin))
  if (!listed || !Object.hasOwn(listed, server))
    return refuse(
      'unlisted',
      `MCP server ${server} is not listed by this plugin.`,
    )
  if (getModMcpSessionOptions().strict)
    return refuse(
      'unlisted',
      'Plugin MCP servers are excluded by --strict-mcp-config.',
    )
  const ownName = `plugin:${plugin.name}:${server}`
  const declared = (await getPluginMcpServers(plugin))?.[ownName]
  if (!declared)
    return refuse('failed', `MCP server ${server} could not be configured.`)
  const denied = refusalFor(ownName, declared)
  if (denied) return denied
  if (doesEnterpriseMcpConfigExist())
    return refuse(
      'policy',
      'Enterprise MCP configuration excludes plugin servers.',
    )
  const configs = await effectiveConfigs()
  const signature = getMcpServerSignature(declared)
  const target =
    configs[ownName]?.pluginSource === plugin.source
      ? ownName
      : Object.keys(configs).find(
          key =>
            !refusalFor(key, configs[key]!) &&
            signature !== null &&
            getMcpServerSignature(configs[key]!) === signature,
        )
  if (!target)
    return refuse(
      'failed',
      `MCP server ${server} is not available in this session.`,
    )
  const config = configs[target]!
  const isCurrent = async () => {
    const plugins = await loadAllPluginsCacheOnly()
    if (
      !plugins.enabled.some(
        (item: LoadedPlugin) =>
          item.source === plugin.source && item.path === plugin.path,
      )
    )
      return false
    const current = (await effectiveConfigs())[target]
    return (
      current &&
      !refusalFor(target, current) &&
      hashMcpConfig(current) === hashMcpConfig(config)
    )
  }
  signal.throwIfAborted()
  if (!(await isCurrent()))
    return refuse('failed', 'The plugin or MCP configuration changed.')
  const prior = await cachedClient(target, config, signal)
  if (
    prior?.type === 'connected' &&
    fetchToolsForClient.cache.get(getServerCacheKey(target, config)) &&
    (await isCurrent())
  )
    return { isConnected: true, server: target }
  // Never tear down a shared live connection. Only retry a completed failure.
  if (prior?.type === 'failed') {
    const key = getServerCacheKey(target, config)
    const pending = connectToServer.cache.get(key)
    if (
      pending &&
      (await pending) === prior &&
      connectToServer.cache.get(key) === pending
    )
      connectToServer.cache.delete(key)
  }
  signal.throwIfAborted()
  if (!(await isCurrent()))
    return refuse('failed', 'The plugin or MCP configuration changed.')
  let settle!: (client: MCPServerConnection) => void
  const ready = new Promise<MCPServerConnection>(resolve => {
    settle = resolve
  })
  const publications: Promise<void>[] = []
  let delivered = false
  const onDiscovery: Parameters<
    typeof getMcpToolsCommandsAndResources
  >[0] = update => {
    publications.push(
      isCurrent()
        .then(async current => {
          const key = getServerCacheKey(target, config)
          const owner = connectToServer.cache.get(key)
          if (
            update.client.type === 'connected' &&
            (!owner || (await owner) !== update.client)
          ) {
            if (update.tools !== undefined)
              settle({ name: target, config, type: 'failed' })
            return
          }
          const stillCurrent = (retired = false) =>
            (connectToServer.cache.get(key) === owner ||
              (retired && !connectToServer.cache.has(key))) &&
            !refusalFor(target, config)
          // Returning ready tools ends the mod invocation. Its signal is
          // then aborted by the worker host; ancillary session discovery
          // still belongs to the live connection, not that finished hook.
          if (current && (!signal.aborted || delivered))
            publish(update, stillCurrent)
          if (update.tools !== undefined) {
            delivered = current === true && !signal.aborted && stillCurrent()
            if (!delivered && connectToServer.cache.get(key) === owner)
              acknowledgeMcpPublication(target)
            settle(update.client)
          }
        })
        .catch(() => {
          acknowledgeMcpPublication(target)
          settle({ name: target, config, type: 'failed' })
        }),
    )
  }
  const releaseReadiness = registerMcpPublisher(onDiscovery)
  const discovery = getMcpToolsCommandsAndResources(onDiscovery, {
    [target]: config,
  })
  // Ancillary discovery may finish later; own its rejection without holding tools back.
  void discovery
    .catch(() => {})
    .then(async () => {
      await Promise.all(publications)
      settle({ name: target, config, type: 'failed' })
    })
    .finally(releaseReadiness)
  const client = await waitFor(ready, signal)
  if (!(await isCurrent()))
    return refuse('failed', 'The plugin or MCP configuration changed.')
  if (client.type === 'connected') return { isConnected: true, server: target }
  return refuse(
    client.type === 'needs-auth'
      ? 'auth'
      : client.type === 'disabled'
        ? 'disabled'
        : 'failed',
    `MCP server ${target} is ${client.type}.`,
  )
}

async function call(
  server: string,
  tool: string,
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
) {
  if (runtimeDisabled()) throw new Error('MCP is disabled in this session')
  const bound = getModToolContext()
  const live = bound ? readModToolSnapshot(bound.toolUseContext).mcpClients : []
  const configs = await effectiveConfigs(live)
  const byName = new Map(live.map(client => [client.name, client]))
  const names = new Set([...Object.keys(configs), ...byName.keys()])
  const matches = names.has(server)
    ? [server]
    : [...names].filter(key => normalizeNameForMCP(key) === server)
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? `Ambiguous MCP server name: ${server}`
        : `MCP server is not available: ${server}`,
    )
  const target = matches[0]!
  let client = byName.get(target)
  // SDK and account connectors are supplied by the live session rather than
  // local config files. Ordinary clients must remain configured, even while
  // their old connection is still present in a render snapshot.
  const sessionConfig = (liveClient: MCPServerConnection | undefined) =>
    liveClient?.config.type === 'sdk' ||
    (liveClient?.config.type === 'claudeai-proxy' &&
      !getModMcpSessionOptions().strict &&
      !doesEnterpriseMcpConfigExist())
      ? liveClient.config
      : undefined
  const config =
    client?.config.type === 'sdk'
      ? sessionConfig(client)
      : (configs[target] ?? sessionConfig(client))
  if (!config) throw new Error(`MCP server is not available: ${server}`)
  const denied = refusalFor(target, config)
  if (denied) throw new Error(denied.message)
  // A removed plugin's client may still be in a render's old snapshot.
  if (config.pluginSource && !configs[target])
    throw new Error(`Plugin MCP server is no longer available: ${target}`)
  const cacheKey = getServerCacheKey(target, config)
  const owner = connectToServer.cache.get(cacheKey)
  if (config.type !== 'sdk') client = await cachedClient(target, config, signal)
  if (client?.type !== 'connected')
    throw new Error(`MCP server is not connected: ${target}`)
  // Connecting can yield while settings, policy or the live session changes.
  // Revoke the pending operation before any remote side effect is sent.
  const latestLive = bound
    ? readModToolSnapshot(bound.toolUseContext).mcpClients
    : []
  const latestConfigs = await effectiveConfigs(latestLive)
  const latestClient = latestLive.find(item => item.name === target)
  const latestConfig =
    config.type === 'sdk'
      ? sessionConfig(latestClient)
      : (latestConfigs[target] ?? sessionConfig(latestClient))
  if (!latestConfig || hashMcpConfig(latestConfig) !== hashMcpConfig(config))
    throw new Error(`MCP server configuration changed: ${target}`)
  const currentDenied = refusalFor(target, latestConfig)
  if (currentDenied) throw new Error(currentDenied.message)
  if (byName.has(target) && bound) {
    const current = readModToolSnapshot(bound.toolUseContext).mcpClients.find(
      item => item.name === target,
    )
    if (
      !current ||
      current.type === 'disabled' ||
      hashMcpConfig(current.config) !== hashMcpConfig(config)
    )
      throw new Error(`MCP server connection changed: ${target}`)
  }
  if (config.type === 'sdk') {
    const current =
      bound &&
      readModToolSnapshot(bound.toolUseContext).mcpClients.find(
        item => item.name === target,
      )
    if (current?.type !== 'connected' || current.client !== client.client)
      throw new Error(`MCP server connection changed: ${target}`)
  } else if (connectToServer.cache.get(cacheKey) !== owner) {
    throw new Error(`MCP server connection changed: ${target}`)
  }
  signal.throwIfAborted()
  const controller = new AbortController()
  const parent = bound?.toolUseContext.abortController.signal
  const abort = () =>
    controller.abort(
      new Error('MCP call interrupted; the server may have executed it.'),
    )
  signal.addEventListener('abort', abort, { once: true })
  parent?.addEventListener('abort', abort, { once: true })
  if (signal.aborted || parent?.aborted) abort()
  const timeout = getMcpToolTimeoutMs()
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error('MCP call timed out; the server may have executed it.'),
      ),
    timeout,
  )
  try {
    controller.signal.throwIfAborted()
    const result = await waitFor(
      client.client.callTool(
        { name: tool, ...(args === undefined ? {} : { arguments: args }) },
        CallToolResultSchema,
        { signal: controller.signal, timeout },
      ),
      controller.signal,
    )
    return {
      ...result,
      content: result.content ?? [],
      isError: result.isError === true,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    parent?.removeEventListener('abort', abort)
  }
}

export async function runModMcpAPI(
  method: string,
  input: Record<string, any>,
  signal: AbortSignal,
  plugin: LoadedPlugin,
) {
  const validated = mcpApiInput(
    method,
    method === 'mcp.connect'
      ? [input.server]
      : [input.server, input.tool, input.args],
  )
  signal.throwIfAborted()
  return method === 'mcp.connect'
    ? connect(plugin, validated.server, signal)
    : call(validated.server, validated.tool!, validated.args, signal)
}
