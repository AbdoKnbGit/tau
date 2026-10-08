import { parse, type SyntaxNode } from '../../utils/treesitter/parser.js'

// Source maps attach to JavaScript/TypeScript and CSS. Do not interpret a
// directive in markdown, JSON, or another language as a source comment.
const LANGUAGES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'tsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  css: 'css',
}

export function supportsInlineSourceMaps(ext: string): boolean {
  return Object.hasOwn(LANGUAGES, ext.toLowerCase())
}

// Match a complete directive comment, never arbitrary base64 or a long line.
// Both current (#) and legacy (@) spellings and CSS block comments occur in
// generated files. External .map URLs are useful and stay visible.
const DIRECTIVE = /^(?:\/\/[#@][\t ]*sourceMappingURL[\t ]*=[\t ]*(data:[^\s]+)[\t ]*|\/\*[#@][\t ]*sourceMappingURL[\t ]*=[\t ]*(data:[^\s]+?)[\t ]*\*\/)$/
const JSON_DATA_URL = /^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.+)$/i

function isInlineMap(comment: string): boolean {
  const directive = DIRECTIVE.exec(comment)
  if (!directive) return false
  const data = JSON_DATA_URL.exec(directive[1] ?? directive[2]!)
  if (!data) return false
  try {
    const payload = data[2]!
    if (data[1] && !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false
    const json = data[1]
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload)
    const map = JSON.parse(json)
    return map !== null && map.version === 3 && (
      (Array.isArray(map.sources) && typeof map.mappings === 'string') ||
      Array.isArray(map.sections)
    )
  } catch {
    return false
  }
}

/** A display-only view, frozen at Read execution, never during replay.
 * Full context is required: regexing the selected range alone can hide a
 * template literal's contents. Missing/failed parsing leaves all text intact.
 * No line is removed, and raw content remains available for edit checks.
 */
export async function inlineSourceMapView(
  content: string,
  fullContent: string | undefined,
  ext: string,
  lineOffset: number,
): Promise<{ content: string; omitted: boolean }> {
  const unchanged = { content, omitted: false }
  if (!supportsInlineSourceMaps(ext) || fullContent === undefined ||
      !content.includes('sourceMappingURL')) return unchanged
  const tree = await parse(LANGUAGES[ext.toLowerCase()]!, fullContent)
  if (!tree) return unchanged
  try {
    if (tree.rootNode.hasError) return unchanged
    const lines = content.split('\n')
    let omitted = false
    const stack: SyntaxNode[] = [tree.rootNode]
    while (stack.length) {
      const node = stack.pop()!
      const row = node.startPosition.row
      if (node.endPosition.row < lineOffset || row >= lineOffset + lines.length) continue
      if (node.type === 'comment' && row === node.endPosition.row) {
        const comment = fullContent.slice(node.startIndex, node.endIndex)
        if (isInlineMap(comment)) {
          const index = row - lineOffset
          const line = lines[index]!
          // Only replace standalone comment lines. Keep code + trailing
          // comments intact rather than risking edits of a partly hidden line.
          if (line.trim() === comment) {
            lines[index] = `[Inline source map omitted (${comment.length} characters); Read with include_source_maps=true to inspect.]`
            omitted = true
          }
        }
        continue
      }
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i)
        if (child) stack.push(child)
      }
    }
    return omitted ? { content: lines.join('\n'), omitted } : unchanged
  } finally {
    tree.delete()
  }
}
