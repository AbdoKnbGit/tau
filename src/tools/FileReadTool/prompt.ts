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
  '- Results are returned using cat -n format, with line numbers starting at 1'

export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- This tool allows Tau to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Tau is a multimodal LLM.${
    isPDFSupported()
      ? '\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.'
      : ''
  }
- LARGE code files auto-skeleton: a whole-file Read (no offset/limit) of a supported code file (ts/js/py/go/rs/java/rb/cs/c/cpp/php and variants) above ~16KB returns the file's STRUCTURE — imports, signatures, and class shapes with long function bodies elided — instead of full content. Each elision marker shows the exact offset/limit Read call to expand that body, and line numbers are the file's real line numbers. Read specific ranges (offset/limit) for the bodies you need, pass skeleton: false to force full content, or skeleton: true to force a skeleton for any supported file. Unsupported files always return a normal read. Editing still requires a full-content Read of the relevant range first.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.${
    isOfficeParseEnabled()
      ? `\n- This tool reads Word, Excel, and OpenDocument files (.docx, .doc, .xlsx, .xls, .odt) by converting them to markdown. Read them DIRECTLY with this tool. Do NOT use ${BASH_TOOL_NAME} with python, docx, zipfile, unzip, or any other workaround to extract their text — this tool handles them and those workarounds lose tables and formatting. Converting uploads the file, so the first one in a session asks the user for approval. The result is a text rendering, so the file cannot be changed with Edit or Write. PowerPoint (.pptx, .ppt) and .ods/.odp are NOT supported by this tool.`
      : ''
  }
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
}
