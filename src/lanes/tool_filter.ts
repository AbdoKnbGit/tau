import { CODEBASE_RETRIEVAL_TOOL_NAME } from '../tools/CodebaseRetrievalTool/constants.js'
import { DEPLOY_PREVIEW_TOOL_NAME } from '../tools/DeployPreviewTool/constants.js'
import { GIT_HISTORY_SEARCH_TOOL_NAME } from '../tools/GitHistorySearchTool/constants.js'
import { INSPECT_SITE_TOOL_NAME } from '../tools/InspectSiteTool/constants.js'
import { INTEGRATION_HUB_TOOL_NAME } from '../tools/IntegrationHubTool/constants.js'
import { MERMAID_RENDER_TOOL_NAME } from '../tools/MermaidRenderTool/constants.js'
import { PACKAGE_MANAGER_TOOL_NAME } from '../tools/PackageManagerTool/constants.js'
import { PROJECT_WORKFLOW_TOOL_NAME } from '../tools/ProjectWorkflowTool/constants.js'
import { SPEC_QUEST_TOOL_NAME } from '../tools/SpecQuestTool/constants.js'
import { TEST_SEARCH_TOOL_NAME } from '../tools/TestSearchTool/constants.js'
import { TOOL_GUIDE_TOOL_NAME } from '../tools/ToolGuideTool/constants.js'
import { VISUAL_DESIGN_AUDIT_TOOL_NAME } from '../tools/VisualDesignAuditTool/constants.js'
import type { ProviderTool } from '../services/api/providers/base_provider.js'
import type { SharedTool } from './types.js'

const CURSOR_EXCLUDED_ADDITION_TOOLS = new Set([
  TOOL_GUIDE_TOOL_NAME,
  PROJECT_WORKFLOW_TOOL_NAME,
  TEST_SEARCH_TOOL_NAME,
  CODEBASE_RETRIEVAL_TOOL_NAME,
  GIT_HISTORY_SEARCH_TOOL_NAME,
  INSPECT_SITE_TOOL_NAME,
  PACKAGE_MANAGER_TOOL_NAME,
  SPEC_QUEST_TOOL_NAME,
  MERMAID_RENDER_TOOL_NAME,
  INTEGRATION_HUB_TOOL_NAME,
  DEPLOY_PREVIEW_TOOL_NAME,
  VISUAL_DESIGN_AUDIT_TOOL_NAME,
])

export function filterProviderToolsForLane(laneName: string, tools: ProviderTool[]): ProviderTool[] {
  if (laneName !== 'cursor') return tools
  return tools.filter(tool => !CURSOR_EXCLUDED_ADDITION_TOOLS.has(tool.name))
}

export function filterSharedToolsForLane(laneName: string, tools: SharedTool[]): SharedTool[] {
  if (laneName !== 'cursor') return tools
  return tools.filter(tool => {
    const visibleName = tool.anthropicDef?.name ?? tool.implId
    return !CURSOR_EXCLUDED_ADDITION_TOOLS.has(tool.implId) && !CURSOR_EXCLUDED_ADDITION_TOOLS.has(visibleName)
  })
}
