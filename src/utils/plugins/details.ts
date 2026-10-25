import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import type { PluginLoadResult } from '../../types/plugin.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  getPluginCommands,
  getPluginSkillInventory,
} from './loadPluginCommands.js'
import { loadPluginAgents } from './loadPluginAgents.js'
import { loadAllPlugins } from './pluginLoader.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'
import { getPluginLastUsed } from './usage.js'

export async function getPluginDetails(identifier: string): Promise<string> {
  const { enabled }: PluginLoadResult = await loadAllPlugins()
  const { name, marketplace } = parsePluginIdentifier(identifier)
  const matches = enabled.filter(p =>
    marketplace
      ? p.source === identifier
      : p.name === name || parsePluginIdentifier(p.source).name === name,
  )
  if (!matches.length)
    throw new Error(
      `Plugin "${identifier}" is not loaded. Install or enable it, or pass --plugin-dir before plugin details.`,
    )
  if (matches.length > 1)
    throw new Error(
      `Plugin "${identifier}" is ambiguous. Use one of: ${matches.map(p => p.source).join(', ')}`,
    )
  const plugin = matches[0]!
  const [legacy, skills, agents, mcp, lsp] = await Promise.all([
    getPluginCommands(),
    getPluginSkillInventory(),
    loadPluginAgents(),
    loadPluginMcpServers(plugin),
    loadPluginLspServers(plugin),
  ])
  const commands = [
    ...new Map(
      [...legacy, ...skills]
        .filter(
          c =>
            c.type === 'prompt' && c.pluginInfo?.repository === plugin.source,
        )
        .map(c => [c.name, c]),
    ).values(),
  ]
  const ownedAgents = (agents as AgentDefinition[]).filter(
    agent => agent.source === 'plugin' && agent.plugin === plugin.source,
  )
  const costs = commands.map(command => ({
    name: command.name,
    alwaysOn: command.disableModelInvocation
      ? 0
      : roughTokenCountEstimation(
          [command.name, command.description, command.whenToUse]
            .filter(Boolean)
            .join(' '),
        ),
    onInvoke:
      command.type === 'prompt' ? Math.ceil(command.contentLength / 4) : 0,
  }))
  for (const agent of ownedAgents) {
    costs.push({
      name: agent.agentType,
      alwaysOn: roughTokenCountEstimation(
        `${agent.agentType} ${agent.whenToUse}`,
      ),
      onInvoke:
        agent.source === 'plugin'
          ? roughTokenCountEstimation(agent.getSystemPrompt())
          : 0,
    })
  }
  const events = plugin.hooksSuppressedBy
    ? []
    : Object.keys(plugin.hooksConfig ?? {})
  const hookCount = plugin.hooksSuppressedBy
    ? 0
    : Object.values(plugin.hooksConfig ?? {}).reduce(
        (sum, matchers) =>
          sum +
          (matchers?.reduce((n, matcher) => n + matcher.hooks.length, 0) ?? 0),
        0,
      )
  const names = (values: string[]) =>
    values.length ? values.join(', ') : '(none)'
  const lastUsed = getPluginLastUsed(plugin.source)
  return [
    `${plugin.name} ${plugin.dependencyVersion ?? plugin.manifest.version ?? ''}`.trim(),
    `  Description: ${plugin.manifest.description ?? ''}`,
    `  Source: ${plugin.source}`,
    '',
    ...(lastUsed ? [`  Last used: ${lastUsed}`, ''] : []),
    'Component inventory',
    `  Skills (${commands.length})  ${names(commands.map(c => c.name))}`,
    `  Agents (${ownedAgents.length})  ${names(ownedAgents.map(a => a.agentType))}`,
    `  Hooks (${hookCount})  ${names(events)} (no model context cost)`,
    `  MCP servers (${Object.keys(mcp ?? {}).length})  ${names(Object.keys(mcp ?? {}))} (runtime tool schemas not counted)`,
    `  LSP servers (${Object.keys(lsp ?? {}).length})  ${names(Object.keys(lsp ?? {}))}`,
    '',
    'Projected token cost',
    `  Always-on: ~${costs.reduce((sum, row) => sum + row.alwaysOn, 0)} tok`,
    ...(costs.length
      ? [
          '',
          'Per-component (estimated)',
          '  component  always-on  on-invoke',
          ...costs.map(
            row => `  ${row.name}  ~${row.alwaysOn}  ~${row.onInvoke}`,
          ),
        ]
      : []),
    '',
    'Token counts are estimates, not billed usage. No skill body or hook was executed to produce this report.',
  ].join('\n')
}
