export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

export const DESCRIPTION = `
List available resources from configured MCP servers; each includes its source \`server\`.

All servers: \`listMcpResources\`
One server: \`listMcpResources({ server: "myserver" })\`
`

export const PROMPT = `
List available resources from configured MCP servers.
Each resource has all standard MCP fields plus \`server\` identifying its source.
Optional \`server\` filters by MCP server name; omit it for all servers.
`
