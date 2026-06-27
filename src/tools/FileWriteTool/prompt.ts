import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getPreReadInstruction(): string {
  return `\n- ALWAYS read an existing file with the ${FILE_READ_TOOL_NAME} tool before overwriting it - read first, every time. \`Write\` replaces the ENTIRE file, so overwriting one you have not read risks destroying its contents, and this tool will refuse until you do. Do the read quietly; do not send routine "let me read" narration to the user. To change only part of a file, use the Edit tool instead (it reads + edits in place).`
}

export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.${getPreReadInstruction()}
- Prefer the Edit tool for modifying existing files \u2014 it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
}
