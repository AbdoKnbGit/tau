import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'
import type { EffortValue } from '../../utils/effort.js'
import type { APIProvider } from '../../utils/model/providers.js'

/** Format an agent definition as a Markdown file with YAML frontmatter. */
export function formatAgentAsMarkdown(
  agentType: string,
  whenToUse: string,
  tools: string[] | undefined,
  systemPrompt: string,
  color?: string,
  model?: string,
  memory?: AgentMemoryScope,
  effort?: EffortValue,
  provider?: APIProvider,
): string {
  const escapedWhenToUse = whenToUse
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\\\n')

  const isAllTools =
    tools === undefined || (tools.length === 1 && tools[0] === '*')
  const toolsLine = isAllTools ? '' : `\ntools: ${tools.join(', ')}`
  const providerLine = provider ? `\nprovider: ${provider}` : ''
  const modelLine = model ? `\nmodel: ${model}` : ''
  const effortLine = effort !== undefined ? `\neffort: ${effort}` : ''
  const colorLine = color ? `\ncolor: ${color}` : ''
  const memoryLine = memory ? `\nmemory: ${memory}` : ''

  return `---
name: ${agentType}
description: "${escapedWhenToUse}"${toolsLine}${providerLine}${modelLine}${effortLine}${colorLine}${memoryLine}
---

${systemPrompt}
`
}
