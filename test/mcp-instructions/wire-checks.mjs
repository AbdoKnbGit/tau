// Provider-neutral inspection of the serialized request, including Kiro's
// toolResults envelope and Gemini's functionResponse parts.
export function hasInstructionsInsideToolOutput(value) {
  if (!value || typeof value !== 'object') return false
  if (
    value.role === 'tool' || value.type === 'tool_result' ||
    value.type === 'function_call_output' || value.type === 'custom_tool_call_output'
  ) {
    if (JSON.stringify(value).includes('<mcp-server-instructions>')) return true
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'functionResponse' || key === 'toolResults') &&
        JSON.stringify(child).includes('<mcp-server-instructions>')) return true
    if (hasInstructionsInsideToolOutput(child)) return true
  }
  return false
}
