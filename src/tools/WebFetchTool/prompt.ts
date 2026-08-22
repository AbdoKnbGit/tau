export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `Fetch a public URL, convert it to Markdown, and answer the supplied extraction prompt. Read-only; large pages may be summarized. Prefer an available MCP fetch tool, and use gh for GitHub URLs. HTTP upgrades to HTTPS. A cross-host redirect returns its new URL without fetching it; call WebFetch again with that URL.`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`

  return `
Web page content:
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
