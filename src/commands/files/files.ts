import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getDisplayPath } from '../../utils/file.js'
import { cacheKeys } from '../../utils/fileStateCache.js'

// The output is rendered as Markdown, so each path goes in a code span.
// Otherwise Windows backslashes act as escapes (\.claude shows as .claude)
// and names like __init__.py turn bold. The fence is longer than any backtick
// run in the path, and the padding keeps a leading or trailing backtick/space.
export function codeSpan(text: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), match => match[0].length),
  )
  const fence = '`'.repeat(longestRun + 1)
  const pad = /^[` ]|[` ]$/.test(text) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  const files = context.readFileState ? cacheKeys(context.readFileState) : []

  if (files.length === 0) {
    return { type: 'text' as const, value: 'No files counted as read yet' }
  }

  // Sorted, because the cache's own order flips every time getChangedFiles
  // looks its entries up.
  const fileList = files
    .map(file => getDisplayPath(file))
    .sort()
    .map(codeSpan)
    .join('\n')
  return {
    type: 'text' as const,
    value: `Files Tau counts as read (${files.length}):\n${fileList}`,
  }
}
