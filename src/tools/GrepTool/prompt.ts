import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

export const GREP_TOOL_NAME = 'Grep'

export function getDescription(): string {
  return `Search file contents with ripgrep regex. Prefer ${GREP_TOOL_NAME} to ${BASH_TOOL_NAME} grep/rg; use ${AGENT_TOOL_NAME} only for open-ended multi-round exploration. Filter with glob or type. Default output lists matching files; content returns lines, count returns counts. Escape literal regex braces and set multiline for cross-line patterns.`
}
