import { isOfficeParseEnabled } from '../../utils/officeDocs.js'
import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Name lives in constants.ts (leaf); re-exported here so existing importers
// keep working without pulling this module's pdfUtils/runtime imports.
export { FILE_READ_TOOL_NAME } from './constants.js'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Text includes 1-based line numbers; never copy the number prefix into edits.'

export const OFFSET_INSTRUCTION_DEFAULT =
  '- Omit offset/limit for the whole file; use them for large or known ranges.'

export const OFFSET_INSTRUCTION_TARGETED =
  '- Read only the needed offset/limit range when its location is known.'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `Read one local file by absolute path. Missing or unreadable files return an actionable error.

- Reads at most ${MAX_LINES_TO_READ} lines by default${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- Images are returned visually.${
    isPDFSupported()
      ? '\n- PDFs support `pages`; PDFs over 10 pages require a range, with at most 20 pages per call.'
      : ''
  }
- Large supported code files may return an automatic structure skeleton. Follow its exact offset/limit markers for bodies, or pass \`skeleton: false\` for full content. Read the edited range verbatim before Edit.
- Notebooks return cells and outputs.${
    isOfficeParseEnabled()
      ? `\n- Read Word/Excel/OpenDocument files directly here; ${BASH_TOOL_NAME} extraction loses structure. Conversion requires first-use approval and returns read-only markdown. PowerPoint/ODS/ODP are unsupported.`
      : ''
  }
- Files only, not directories. Use ${BASH_TOOL_NAME} for directory listings. Read screenshot paths with this tool.`
}
