import type { SettingSource } from '../../../utils/settings/constants.js'
import type { APIProvider } from '../../../utils/model/providers.js'
import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import type { CustomAgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'

export interface AgentWizardData extends Record<string, unknown> {
  location?: SettingSource
  method?: 'generate' | 'manual'
  generationPrompt?: string
  isGenerating?: boolean
  wasGenerated?: boolean
  generatedAgent?: {
    identifier: string
    whenToUse: string
    systemPrompt: string
  }
  agentType?: string
  whenToUse?: string
  systemPrompt?: string
  selectedTools?: string[]
  selectedModel?: string
  selectedProvider?: APIProvider
  selectedColor?: string
  selectedMemory?: AgentMemoryScope
  finalAgent?: CustomAgentDefinition
}
