import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'

// Name lives in constants.ts (leaf); re-exported here so existing importers
// keep working without pulling this module's FileReadTool/prompt chain.
export { FILE_WRITE_TOOL_NAME } from './constants.js'
export const DESCRIPTION = 'Write a file to the local filesystem.'

export function getWriteToolDescription(): string {
  return `Create a file or replace its entire contents.
- Read an existing file with ${FILE_READ_TOOL_NAME} immediately before overwriting it; this is enforced.
- Prefer Edit for partial changes; use Write for new files or intentional complete rewrites.
- Create documentation or add emoji only when requested.`
}
