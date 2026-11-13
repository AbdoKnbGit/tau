import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getDisplayPath } from '../../utils/file.js'
import { cacheKeys } from '../../utils/fileStateCache.js'
import { codeSpan } from '../../utils/format.js'

export { codeSpan } from '../../utils/format.js'

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
