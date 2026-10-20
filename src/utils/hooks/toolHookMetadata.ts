import type { ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'

export function toolHookServer(toolName: string, context: ToolUseContext) {
  const tool = findToolByName(context.options.tools, toolName)
  if (!tool?.mcpInfo) return undefined
  const name = tool.mcpInfo.serverName
  const client = context.getAppState().mcp.clients.find(client => client.name === name)
    ?? context.options.mcpClients.find(client => client.name === name)
  if (!client) return undefined
  const config = client.config
  return {
    name,
    source: config.pluginSource
      ? 'plugin'
      : config.type === 'sdk' || config.scope === 'dynamic' ? 'sdk' : config.scope,
  }
}

/** Preserve richer provider error codes at the hook boundary only. */
export function stopFailureHookError(error: string | undefined, details: string | undefined): string {
  const text = `${error ?? ''}\n${details ?? ''}`
  for (const code of ['overloaded', 'oauth_org_not_allowed', 'account_on_hold', 'model_not_found', 'cloud_credential_error']) {
    if (new RegExp(`\\b${code}(?:_error)?\\b`, 'i').test(text)) return code
  }
  return error ?? 'unknown'
}
