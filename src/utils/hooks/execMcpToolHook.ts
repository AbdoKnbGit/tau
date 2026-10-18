import type { McpToolHook } from '../../schemas/hooks.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { sleep } from '../sleep.js'
import { errorMessage } from '../errors.js'
import { isDecidingHookEvent } from './hookPolicy.js'

/**
 * Replaces each `${path}` in the string values of `value` with the field of
 * the hook input at that dotted path, as in `${tool_input.file_path}`. A
 * missing field becomes an empty string; a non-string one its JSON.
 */
export function substituteHookInputPaths(
  value: unknown,
  hookInput: unknown,
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_placeholder, path: string) => {
      let found: unknown = hookInput
      for (const key of path.split('.')) {
        found =
          found !== null && typeof found === 'object' && Object.hasOwn(found, key)
            ? (found as Record<string, unknown>)[key]
            : undefined
      }
      if (found === undefined || found === null) return ''
      return typeof found === 'string' ? found : JSON.stringify(found)
    })
  }
  if (Array.isArray(value)) {
    return value.map(item => substituteHookInputPaths(item, hookInput))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteHookInputPaths(item, hookInput),
      ]),
    )
  }
  return value
}

export type McpToolHookRun =
  | { skipped: string }
  | {
      stdout: string
      stderr: string
      output: string
      status: number
      aborted?: boolean
    }

function connectWaitMs(): number {
  return parseInt(process.env.MCP_TIMEOUT || '', 10) || 30_000
}

/**
 * Calls an mcp_tool hook's tool and returns its text the way a command
 * hook's output reads: text content as stdout with status 0, or with status 1
 * when the tool reports an error or cannot be called. On events where the
 * hook can decide something, a server that is still connecting is waited
 * for, up to MCP_TIMEOUT and within the hook's own timeout.
 */
export async function execMcpToolHook({
  hook,
  hookEvent,
  hookInput,
  signal,
  timeoutMs,
  getClients,
}: {
  hook: McpToolHook
  hookEvent: string
  hookInput: unknown
  signal: AbortSignal
  timeoutMs: number
  getClients: (() => readonly MCPServerConnection[]) | undefined
}): Promise<McpToolHookRun> {
  if (!getClients) {
    return {
      skipped: `mcp_tool hooks are not available for the '${hookEvent}' hook event (no MCP client context)`,
    }
  }
  const failure = (stderr: string) => ({
    stdout: '',
    stderr,
    output: stderr,
    status: 1,
  })
  if (signal.aborted) return { ...failure('Hook cancelled'), aborted: true }
  const find = () => getClients().find(client => client.name === hook.server)
  let server = find()
  if (!server) return failure(`MCP server "${hook.server}" is not configured`)

  if (server.type === 'pending' && isDecidingHookEvent(hookEvent)) {
    const deadline = Date.now() + Math.min(connectWaitMs(), timeoutMs)
    while (server?.type === 'pending' && Date.now() < deadline) {
      await sleep(100, signal)
      if (signal.aborted) return { ...failure('Hook cancelled'), aborted: true }
      server = find()
    }
  }
  if (server?.type !== 'connected') {
    return failure(`MCP server "${hook.server}" is not connected`)
  }

  try {
    const result = await server.client.callTool(
      {
        name: hook.tool,
        arguments: substituteHookInputPaths(hook.input ?? {}, hookInput) as
          | Record<string, unknown>
          | undefined,
      },
      undefined,
      { signal, timeout: timeoutMs },
    )
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .flatMap(block =>
        block.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : [],
      )
      .join('\n')
    if (result.isError) {
      return failure(text || `MCP tool ${hook.tool} returned an error`)
    }
    return { stdout: text, stderr: '', output: text, status: 0 }
  } catch (error) {
    if (signal.aborted) return { ...failure('Hook cancelled'), aborted: true }
    return failure(`MCP tool ${hook.tool} failed: ${errorMessage(error)}`)
  }
}
