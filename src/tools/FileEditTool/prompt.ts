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
  // Large old_strings fail on any drift (one blank line, one remembered
  // line), so every provider gets the size rule.
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- Read line prefixes use ${prefixFormat}; exclude the prefix but preserve content indentation.
- \`old_string\` must be unique unless \`replace_all\` is true.
- Keep \`old_string\` to the lines you change plus 2-3 lines of context; split a large change into several edits.
- A successful edit makes earlier text stale. Use the returned updated region or re-read before the next overlapping edit.
- On not-found, use the error's current/closest text; never guess. If it says already applied, do not retry.
- Prefer Edit for existing files. Add documentation or emoji only when requested.`
}
