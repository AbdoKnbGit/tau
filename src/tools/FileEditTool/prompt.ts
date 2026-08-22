import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getPreReadInstruction(): string {
  return `\n- Read the current target range with ${FILE_READ_TOOL_NAME} first; \`old_string\` must match it exactly.`
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? '\n- Prefer the smallest clearly unique old_string, usually 2-4 lines.'
      : ''
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- Read line prefixes use ${prefixFormat}; exclude the prefix but preserve content indentation.
- \`old_string\` must be unique unless \`replace_all\` is true.${minimalUniquenessHint}
- A successful edit makes earlier text stale. Use the returned updated region or re-read before the next overlapping edit.
- On not-found, use the error's current/closest text; never guess. If it says already applied, do not retry.
- Prefer Edit for existing files. Add documentation or emoji only when requested.`
}
