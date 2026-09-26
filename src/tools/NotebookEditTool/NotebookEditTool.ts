import { agentFileConflictMessage, checkAgentFileClaim } from '../../utils/agentFileClaims.js'
import { feature } from 'bun:bundle'
import { extname } from 'path'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/utils/fileHistory.js'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import type { NotebookCell, NotebookContent } from '../../types/notebook.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { safeParseJSON } from '../../utils/json.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { notebookCellsAsText, readNotebook } from '../../utils/notebook.js'
import {
  findNotebookCellIndex,
  notebookCellDisplayId,
  parseCellId,
} from '../../utils/notebookCellId.js'
import {
  refuseWithCurrentContent,
  unreadFileRefusal,
} from '../../utils/readHistory.js'
import { expandPath } from '../../utils/path.js'
import { checkWritePermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from './constants.js'
import {
  getNotebookNoOpMessage,
  isNotebookReplaceNoOp,
  notebookChangedSinceRead,
} from './notebookNoOp.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.strictObject({
    notebook_path: z
      .string()
      .describe(
        'Absolute .ipynb path',
      ),
    cell_id: z
      .string()
      .optional()
      .describe(
        'Exact Read cell ID. Required for replace/delete; insert goes after it or at the beginning when omitted.',
      ),
    new_source: z
      .string()
      .describe(
        'New cell source; use empty string for delete',
      ),
    cell_type: z
      .enum(['code', 'markdown'])
      .optional()
      .describe(
        'REQUIRED for insert; optional new type for replace; ignored for delete',
      ),
    edit_mode: z
      .enum(['replace', 'insert', 'delete'])
      .optional()
      .describe(
        'Defaults to replace; insert requires cell_type',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    new_source: z
      .string()
      .describe('The new source code that was written to the cell'),
    cell_id: z
      .string()
      .optional()
      .describe('The ID of the cell that was edited'),
    cell_type: z.enum(['code', 'markdown']).describe('The type of the cell'),
    language: z.string().describe('The programming language of the notebook'),
    edit_mode: z.string().describe('The edit mode that was used'),
    error: z
      .string()
      .optional()
      .describe('Error message if the operation failed'),
    noOp: z
      .boolean()
      .optional()
      .describe('True when the requested replacement was already applied'),
    // Fields for attribution tracking
    notebook_path: z.string().describe('The path to the notebook file'),
    original_file: z
      .string()
      .describe('The original notebook content before modification'),
    updated_file: z
      .string()
      .describe('The updated notebook content after modification'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Side-channel from call() to mapToolResultToToolResultBlockParam, keyed by
// the result object like FileReadTool's notes, so the output schema (and the
// SDK types built from it) stays unchanged.
const layoutNotes = new WeakMap<object, string>()

const MAX_LISTED_CELLS = 60

/**
 * After an insert or delete at `from`, every cell without a stored id at or
 * after that position is now named by a different `cell-N` than the model
 * last saw, and an old id may name a different cell. Returns a note listing
 * the current ids, or undefined when no positional id moved.
 */
type LayoutCell = {
  id?: string | null
  cell_type: string
  source?: string | string[]
}

function describeShiftedPositions(
  cells: ReadonlyArray<LayoutCell>,
  from: number,
): string | undefined {
  if (!cells.some((cell, index) => index >= from && cell.id == null)) {
    return undefined
  }
  const lines = cells.slice(0, MAX_LISTED_CELLS).map((cell, index) => {
    const source = Array.isArray(cell.source)
      ? cell.source.join('')
      : String(cell.source ?? '')
    const firstLine = source.split('\n').find(line => line.trim()) ?? ''
    const preview =
      firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine
    return `${notebookCellDisplayId(cell, index)} (${cell.cell_type}): ${preview}`
  })
  if (cells.length > MAX_LISTED_CELLS) {
    lines.push(
      `...and ${cells.length - MAX_LISTED_CELLS} more cells; Read the notebook to see them all.`,
    )
  }
  return `Cells without a stored id are named by their position, so the cells after this one now have different ids, and an id from your earlier Read may name another cell. Current cells:\n${lines.join('\n')}`
}

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  searchHint: 'edit Jupyter notebook cells (.ipynb)',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return 'Edit Notebook'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing notebook ${summary}` : 'Editing notebook'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const mode = input.edit_mode ?? 'replace'
      return `${input.notebook_path} ${mode}: ${input.new_source}`
    }
    return ''
  },
  getPath(input): string {
    return input.notebook_path
  },
  backfillObservableInput(input) {
    // Expand so hook allowlists can't be bypassed via ~/relative paths, and so
    // the observed path matches the canonical spelling used everywhere else
    // (and the readFileState key the Read tool stored under).
    if (typeof input.notebook_path === 'string') {
      input.notebook_path = expandPath(input.notebook_path)
    }
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      NotebookEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const { cell_id, edit_mode, new_source, error, noOp } = data
    const layoutNote = layoutNotes.get(data)
    const withLayout = (text: string) =>
      layoutNote ? `${text}\n\n${layoutNote}` : text
    if (error) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: error,
        is_error: true,
      }
    }
    if (noOp) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: getNotebookNoOpMessage(cell_id),
      }
    }
    switch (edit_mode) {
      case 'replace':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Updated cell ${cell_id} with ${new_source}`,
        }
      case 'insert':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: withLayout(`Inserted cell ${cell_id} with ${new_source}`),
        }
      case 'delete':
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: withLayout(`Deleted cell ${cell_id}`),
        }
      default:
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: 'Unknown edit mode',
        }
    }
  },
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async validateInput(
    { notebook_path, cell_type, cell_id, edit_mode = 'replace' },
    toolUseContext: ToolUseContext,
  ) {
    // Normalize identically to FileReadTool/FileEditTool (expandPath) so the
    // readFileState key matches what the Read tool stored. Without this, a Git
    // Bash path like /c/Users/... is looked up verbatim while Read stored it as
    // C:\Users\..., so the read-before-edit gate fires even after a real read.
    const fullPath = expandPath(notebook_path)

    // Ownership check before any other validation — see FileEditTool.
    const claimOwner = checkAgentFileClaim(fullPath)
    if (claimOwner) {
      return {
        result: false,
        message: agentFileConflictMessage(fullPath, claimOwner),
        errorCode: 0,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    if (fullPath.startsWith('\\\\') || fullPath.startsWith('//')) {
      return { result: true }
    }

    if (extname(fullPath) !== '.ipynb') {
      return {
        result: false,
        message:
          'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the FileEdit tool.',
        errorCode: 2,
      }
    }

    if (
      edit_mode !== 'replace' &&
      edit_mode !== 'insert' &&
      edit_mode !== 'delete'
    ) {
      return {
        result: false,
        message: 'Edit mode must be replace, insert, or delete.',
        errorCode: 4,
      }
    }

    if (edit_mode === 'insert' && !cell_type) {
      return {
        result: false,
        message:
          'Cell type is required when using edit_mode=insert. Set cell_type to "code" or "markdown".',
        errorCode: 5,
      }
    }

    // Require Read-before-Edit (matches FileEditTool/FileWriteTool). Without
    // this, the model could edit a notebook it never saw, or edit against a
    // stale view after an external change — silent data loss. The refusal
    // shows the current cells and records them as the model's read (as the
    // Read tool would), so the next edit uses real cell ids instead of
    // repeating into a loop.
    const readTimestamp = toolUseContext.readFileState.get(fullPath)
    if (!readTimestamp) {
      let shown: string | undefined
      try {
        const cells = await readNotebook(fullPath)
        shown = refuseWithCurrentContent(
          fullPath,
          toolUseContext,
          {
            content: jsonStringify(cells),
            timestamp: getFileModificationTime(fullPath),
          },
          'Edit again with a cell_id from its current cells below (outputs are not shown)',
          { display: notebookCellsAsText(cells) },
        )
      } catch {
        // Missing or unparsable: fall back to asking for a Read.
      }
      return {
        result: false,
        message:
          shown ??
          unreadFileRefusal(fullPath, toolUseContext.agentId, {
            neverRead:
              'Read the target .ipynb with the Read tool first, then use the cell_id values shown in the Read output.',
            action: 'before editing it',
            after: 'use the cell_id values shown in the Read output',
          }),
        errorCode: 9,
      }
    }
    if (getFileModificationTime(fullPath) > readTimestamp.timestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 10,
      }
    }

    let content: string
    try {
      content = readFileSyncWithMetadata(fullPath).content
    } catch (e) {
      if (isENOENT(e)) {
        return {
          result: false,
          message: 'Notebook file does not exist.',
          errorCode: 1,
        }
      }
      throw e
    }
    const notebook = safeParseJSON(content) as NotebookContent | null
    if (!notebook) {
      return {
        result: false,
        message: 'Notebook is not valid JSON.',
        errorCode: 6,
      }
    }
    if (!cell_id) {
      if (edit_mode !== 'insert') {
        return {
          result: false,
          message:
            'Cell ID must be specified when not inserting a new cell. Use a cell_id exactly as shown in the Read output.',
          errorCode: 7,
        }
      }
    } else if (findNotebookCellIndex(notebook.cells, cell_id) === -1) {
      const position = parseCellId(cell_id)
      const cellAtPosition =
        position === undefined ? undefined : notebook.cells[position]
      if (cellAtPosition?.id != null) {
        return {
          result: false,
          message: `Cell "${cell_id}" not found. The cell at position ${position} has its own id "${cellAtPosition.id}": a position like ${cell_id} only names a cell without an id, and positions shift when cells are inserted or deleted. Use the ids from your latest Read or NotebookEdit result, or Read the notebook again.`,
          errorCode: 8,
        }
      }
      if (position !== undefined) {
        return {
          result: false,
          message: `Cell with index ${position} does not exist in notebook. It has ${notebook.cells.length} cells.`,
          errorCode: 7,
        }
      }
      return {
        result: false,
        message: `Cell with ID "${cell_id}" not found in notebook. Read the notebook again to see its current cell ids.`,
        errorCode: 8,
      }
    }

    return { result: true }
  },
  async call(
    {
      notebook_path,
      new_source,
      cell_id,
      cell_type,
      edit_mode: originalEditMode,
    },
    { readFileState, updateFileHistoryState },
    _,
    parentMessage,
  ) {
    // Same expandPath normalization as validateInput so file-history, read, and
    // write all use one canonical path spelling (and match the Read tool's key).
    const fullPath = expandPath(notebook_path)

    // Snapshot exact on-disk bytes before the asynchronous history hook. The
    // Read tool stores a rendered cell view for notebooks, not raw .ipynb JSON,
    // so this local snapshot is the only reliable same-timestamp race guard.
    const contentBeforeHooks = readFileSyncWithMetadata(fullPath).content

    // Fast no-op check before history. This read never leads to a write; the
    // authoritative read/parse below still happens after the final await so
    // there is no lost-update window.
    if ((originalEditMode ?? 'replace') === 'replace' && cell_id) {
      try {
        const notebook = jsonParse(contentBeforeHooks) as NotebookContent
        const cellIndex = findNotebookCellIndex(notebook.cells, cell_id)
        const targetCell = notebook.cells[cellIndex]
        if (
          targetCell &&
          isNotebookReplaceNoOp(targetCell, new_source, cell_type)
        ) {
          return {
            data: {
              new_source,
              cell_type: targetCell.cell_type,
              language: notebook.metadata.language_info?.name ?? 'python',
              edit_mode: 'replace',
              cell_id: targetCell.id ?? cell_id,
              error: '',
              noOp: true,
              notebook_path: fullPath,
              original_file: contentBeforeHooks,
              updated_file: contentBeforeHooks,
            },
          }
        }
      } catch {
        // The authoritative path below preserves existing actionable errors.
      }
    }

    if (fileHistoryEnabled()) {
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullPath,
        parentMessage.uuid,
      )
    }

    try {
      // readFileSyncWithMetadata gives content + encoding + line endings in
      // one safeResolvePath + readFileSync pass, replacing the previous
      // detectFileEncoding + readFile + detectLineEndings chain (each of
      // which redid safeResolvePath and/or a 4KB readSync).
      const { content, encoding, lineEndings } =
        readFileSyncWithMetadata(fullPath)
      const lastRead = readFileState.get(fullPath)
      if (
        notebookChangedSinceRead(
          content,
          getFileModificationTime(fullPath),
          lastRead,
          contentBeforeHooks,
        )
      ) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
      // Must use non-memoized jsonParse here: safeParseJSON caches by content
      // string and returns a shared object reference, but we mutate the
      // notebook in place below (cells.splice, targetCell.source = ...).
      // Using the memoized version poisons the cache for validateInput() and
      // any subsequent call() with the same file content.
      let notebook: NotebookContent
      try {
        notebook = jsonParse(content) as NotebookContent
      } catch {
        return {
          data: {
            new_source,
            cell_type: cell_type ?? 'code',
            language: 'python',
            edit_mode: 'replace',
            error: 'Notebook is not valid JSON.',
            cell_id,
            notebook_path: fullPath,
            original_file: '',
            updated_file: '',
          },
        }
      }

      let cellIndex
      if (!cell_id) {
        cellIndex = 0 // Default to inserting at the beginning if no cell_id is provided
      } else {
        cellIndex = findNotebookCellIndex(notebook.cells, cell_id)
        if (cellIndex === -1) {
          // validateInput found this cell; the notebook changed since then.
          throw new Error(
            `Cell with ID "${cell_id}" not found in notebook. Read the notebook again to see its current cell ids.`,
          )
        }

        if (originalEditMode === 'insert') {
          cellIndex += 1 // Insert after the cell with this ID
        }
      }

      // Convert replace to insert if trying to replace one past the end
      let edit_mode = originalEditMode ?? 'replace'
      if (edit_mode === 'replace' && cellIndex === notebook.cells.length) {
        edit_mode = 'insert'
        if (!cell_type) {
          cell_type = 'code' // Default to code if no cell_type specified
        }
      }

      const language = notebook.metadata.language_info?.name ?? 'python'
      // nbformat 4.5+ stores an id on every cell, so a new cell gets one.
      let new_cell_id = undefined
      if (
        edit_mode === 'insert' &&
        (notebook.nbformat > 4 ||
          (notebook.nbformat === 4 && notebook.nbformat_minor >= 5))
      ) {
        new_cell_id = Math.random().toString(36).substring(2, 15)
      }

      if (edit_mode === 'replace') {
        const targetCell = notebook.cells[cellIndex]!
        if (isNotebookReplaceNoOp(targetCell, new_source, cell_type)) {
          return {
            data: {
              new_source,
              cell_type: targetCell.cell_type,
              language,
              edit_mode,
              cell_id: targetCell.id ?? cell_id,
              error: '',
              noOp: true,
              notebook_path: fullPath,
              original_file: content,
              updated_file: content,
            },
          }
        }
      }

      // The id the model sees for the affected cell, as Read shows ids. Never
      // undefined: a cell without a stored id is named by its position.
      let resultCellId: string
      if (edit_mode === 'delete') {
        resultCellId = notebookCellDisplayId(notebook.cells[cellIndex]!, cellIndex)
        // Delete the specified cell
        notebook.cells.splice(cellIndex, 1)
      } else if (edit_mode === 'insert') {
        let new_cell: NotebookCell
        if (cell_type === 'markdown') {
          new_cell = {
            cell_type: 'markdown',
            id: new_cell_id,
            source: new_source,
            metadata: {},
          }
        } else {
          new_cell = {
            cell_type: 'code',
            id: new_cell_id,
            source: new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          }
        }
        // Insert the new cell
        notebook.cells.splice(cellIndex, 0, new_cell)
        resultCellId = notebookCellDisplayId(new_cell, cellIndex)
      } else {
        // Find the specified cell
        const targetCell = notebook.cells[cellIndex]! // validateInput ensures cell_number is in bounds
        resultCellId = notebookCellDisplayId(targetCell, cellIndex)
        targetCell.source = new_source
        if (targetCell.cell_type === 'code') {
          // Reset execution count and clear outputs since cell was modified
          targetCell.execution_count = null
          targetCell.outputs = []
        }
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type
        }
      }
      // Write back to file
      const IPYNB_INDENT = 1
      const updatedContent = jsonStringify(notebook, null, IPYNB_INDENT)
      writeTextContent(fullPath, updatedContent, encoding, lineEndings)
      // Update readFileState with post-write mtime (matches FileEditTool/
      // FileWriteTool). offset:undefined breaks FileReadTool's dedup match —
      // without this, Read→NotebookEdit→Read in the same millisecond would
      // return the file_unchanged stub against stale in-context content.
      readFileState.set(fullPath, {
        content: updatedContent,
        timestamp: getFileModificationTime(fullPath),
        offset: undefined,
        limit: undefined,
      })
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language,
        edit_mode: edit_mode ?? 'replace',
        cell_id: resultCellId,
        error: '',
        notebook_path: fullPath,
        original_file: content,
        updated_file: updatedContent,
      }
      if (edit_mode === 'insert' || edit_mode === 'delete') {
        const layoutNote = describeShiftedPositions(notebook.cells, cellIndex)
        if (layoutNote) layoutNotes.set(data, layoutNote)
      }
      return {
        data,
      }
    } catch (error) {
      if (error instanceof Error) {
        const data = {
          new_source,
          cell_type: cell_type ?? 'code',
          language: 'python',
          edit_mode: 'replace',
          error: error.message,
          cell_id,
          notebook_path: fullPath,
          original_file: '',
          updated_file: '',
        }
        return {
          data,
        }
      }
      const data = {
        new_source,
        cell_type: cell_type ?? 'code',
        language: 'python',
        edit_mode: 'replace',
        error: 'Unknown error occurred while editing notebook',
        cell_id,
        notebook_path: fullPath,
        original_file: '',
        updated_file: '',
      }
      return {
        data,
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
