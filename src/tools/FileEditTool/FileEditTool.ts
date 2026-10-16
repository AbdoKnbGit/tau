import { agentFileConflictMessage, checkAgentFileClaim } from '../../utils/agentFileClaims.js'
import { dirname, isAbsolute, sep } from 'path'
import { pathToFileURL } from 'url'
import { logEvent } from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { recordVisitedDir } from '../../bootstrap/state.js'
import { getMemoryIndexWarning } from '../../memdir/memoryIndexGuard.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateBuiltinImports } from '../../utils/importCheck.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { validateEditSyntax } from '../../utils/treesitter/validateEdit.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import {
  FILE_EDIT_TOOL_NAME,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
} from './constants.js'
import {
  capEditResultSnippet,
  describeClosestMatch,
  describeOldStringMismatch,
  type FlexibleMatchType,
  isEditLikelyAlreadyApplied,
  lineShiftAfterEdit,
  occurrenceLines,
  type OldStringMismatch,
  previewOldString,
  resolveFlexibleMatch,
} from './matchResolver.js'
import { getEditToolDescription } from './prompt.js'
import { noteFileRead, recordUnreadEditRefusal } from './readFirstGuard.js'
import {
  recordFileRead,
  refuseWithCurrentContent,
  unreadFileRefusal,
} from '../../utils/readHistory.js'
import {
  type FileState,
  readStillMatchesFile,
} from '../../utils/fileStateCache.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import {
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  getSnippetForPatch,
  preserveQuoteStyle,
} from './utils.js'

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.new_string}`
  },
  getPath(input): string {
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  isResultTruncated,
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // Use expandPath for consistent path normalization (especially on Windows
    // where "/" vs "\" can cause readFileState lookup mismatches)
    const fullFilePath = expandPath(file_path)
    // Ownership check first: it must run before the file is read or old_string
    // is matched, otherwise the tool's own "not found" rejection fires first
    // and never mentions the agent that actually holds this path.
    const claimOwner = checkAgentFileClaim(fullFilePath)
    if (claimOwner) {
      return {
        result: false,
        message: agentFileConflictMessage(fullFilePath, claimOwner),
        errorCode: 0,
      }
    }

    // Reject edits to team memory files that introduce secrets
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    // old_string === new_string is a no-op, NOT an error. Rejecting it here
    // made every provider loop: the model re-issued the identical call, got the
    // same error, and never progressed (the "No changes to make" / "Error
    // editing file" churn in the bug reports). We let it through and resolve it
    // idempotently in call() — if old_string genuinely isn't in the file, the
    // "String to replace not found" check below still fires (with the current
    // content as a recovery hint), so a wrong assumption is never masked.

    // Check if path should be ignored based on permission settings
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // Prevent OOM on multi-GB files.
    try {
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
    }

    // Read the file as bytes first so we can detect encoding from the buffer
    // instead of calling detectFileEncoding (which does its own sync readSync
    // and would fail with a wasted ENOENT when the file doesn't exist).
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null
      } else {
        throw e
      }
    }

    // File doesn't exist
    if (fileContent === null) {
      // Empty old_string on nonexistent file means new file creation — valid
      if (old_string === '') {
        return { result: true }
      }
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // File exists with empty old_string — only valid if file is empty
    if (old_string === '') {
      // Only reject if the file has content (for file creation attempt)
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // Empty file with empty old_string is valid - we're replacing empty with content
      return {
        result: true,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    let readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (readTimestamp) {
      // A real read exists (full or windowed) — reset the blind-edit refusal
      // count so a later blind edit of this file is counted from zero.
      noteFileRead(fullFilePath)
    } else {
      // Read-before-Edit (matches FileWriteTool/NotebookEditTool). A blind edit
      // — no current read of this file — is never applied. The refusal shows
      // the current content, recorded as the model's read, so its next edit is
      // grounded and the refusal cannot repeat into a loop. This returns to the
      // MODEL as a <tool_use_error> tool_result (never a user prompt). Only a
      // file too large to show, with nothing close to old_string, falls back to
      // asking for a Read; repeats of that are counted to make it firmer.
      // New-file creation (old_string === '') returned earlier.
      const shown = refuseWithCurrentContent(
        fullFilePath,
        toolUseContext,
        {
          content: fileContent,
          timestamp: getFileModificationTime(fullFilePath),
        },
        'Base old_string on the current content below and edit again',
        { window: () => describeClosestMatch(fileContent, old_string) },
      )
      if (shown) {
        noteFileRead(fullFilePath)
        return { result: false, message: shown, errorCode: 6 }
      }
      const attempt = recordUnreadEditRefusal(fullFilePath)
      return {
        result: false,
        message:
          unreadFileRefusal(fullFilePath, toolUseContext.agentId, {
            neverRead:
              "Read it first with the Read tool before editing it — your old_string must match the file's exact current contents character-for-character.",
            action: 'before editing it',
          }) +
          (attempt > 1
            ? ' Edits to this file are refused until you read it; repeating the edit without a Read fails the same way.'
            : ''),
        errorCode: 6,
      }
    }

    // The model has seen only a partial view (a skeleton, or content injected
    // with parts removed): seed a full read-state from disk and proceed. Safety
    // is still enforced by the old_string match below — a region the model
    // never saw fails with "String to replace not found", never a silent
    // clobber.
    if (readTimestamp.isPartialView) {
      const seeded = {
        content: fileContent,
        timestamp: getFileModificationTime(fullFilePath),
        offset: undefined,
        limit: undefined,
        ...carriedReadState(readTimestamp),
      }
      toolUseContext.readFileState.set(fullFilePath, seeded)
      readTimestamp = seeded
    }

    // Check if file exists and get its last modified time
    if (readTimestamp) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > readTimestamp.timestamp) {
        // Timestamp indicates modification, but timestamps change without
        // content changes (cloud sync, antivirus, a touch), and a change
        // elsewhere in the file leaves the lines the model read intact. When
        // the read's own text is still on disk at the same lines, refresh its
        // timestamp so call()'s write-time check agrees, and proceed: the
        // old_string match below still has to be exact.
        if (readStillMatchesFile(readTimestamp, fileContent)) {
          readTimestamp = { ...readTimestamp, timestamp: lastWriteTime }
          toolUseContext.readFileState.set(fullFilePath, readTimestamp)
        } else {
          return {
            result: false,
            behavior: 'ask',
            message:
              staleReadRefusal(
                fullFilePath,
                toolUseContext,
                fileContent,
                lastWriteTime,
                old_string,
                readTimestamp,
              ) ??
              'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
            errorCode: 7,
          }
        }
      }
    }

    const file = fileContent

    // Use findActualString to handle quote normalization
    let actualOldString = findActualString(file, old_string)

    // Whitespace-flexible fallback: the model's old_string differs from the
    // file only by trailing whitespace or a uniform indent shift — typical
    // drift after its own earlier edit or a formatter pass. Resolves to the
    // file's REAL text, and only when that region is unique, so the edit
    // proceeds instead of failing. call() re-resolves with the same functions
    // and therefore reaches the same conclusion.
    if (!actualOldString) {
      const flex = resolveFlexibleMatch(file, old_string, new_string)
      if (flex) {
        actualOldString = flex.actualOldString
      }
    }

    if (!actualOldString) {
      // The intended end-state may already be in the file: the model repeated
      // an edit it already made (chained edits against a stale mental copy).
      // Say so explicitly — a bare "not found" sends models into
      // guess-the-old_string retry loops.
      if (isEditLikelyAlreadyApplied(file, new_string)) {
        const at =
          occurrenceLines(file, new_string, 1)[0] ??
          occurrenceLines(file, new_string.trim(), 1)[0]
        return {
          result: false,
          behavior: 'ask',
          message: `String to replace not found in file, but new_string is already present${at === undefined ? '' : ` at line ${at}`} — this edit has most likely ALREADY been applied (e.g. by your own earlier edit). Do not retry the same edit. If you intended a different change, Read the file and base old_string on its current content.\nString: ${previewOldString(old_string)}`,
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
          },
          errorCode: 11,
        }
      }

      // Anchor the retry: models that edited blind (or against a stale view)
      // keep guessing old_string variants and loop. Show real current content
      // — the whole file when small, else the region old_string resembles,
      // centered on the line where it stops matching — and name that line,
      // so the next attempt copies it exactly instead of guessing again.
      const mismatch = describeOldStringMismatch(file, old_string)
      let recoveryHint: string
      if (file.length <= 2000) {
        recoveryHint = `\n${differenceSummary(mismatch, old_string)}Current file content:\n${file}`
      } else {
        recoveryHint = mismatch
          ? retryHintFromMismatch(mismatch, old_string)
          : '\nRead the file with the Read tool to see its current content, then retry with an exact, character-for-character old_string.'
      }
      return {
        result: false,
        behavior: 'ask',
        message: `String to replace not found in file.\nString: ${previewOldString(old_string)}\n${recoveryHint}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    const matches = file.split(actualOldString).length - 1

    // Check if we have multiple matches but replace_all is false
    if (matches > 1 && !replace_all) {
      const at = occurrenceLines(file, actualOldString, MAX_LISTED_MATCHES)
      const more = matches - at.length
      return {
        result: false,
        behavior: 'ask',
        message: `Found ${matches} matches of the string to replace (starting at lines ${at.join(', ')}${more > 0 ? `, and ${more} more` : ''}), but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${previewOldString(old_string)}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          actualOldString,
        },
        errorCode: 9,
      }
    }

    // Additional validation for Claude settings files
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => {
        // Simulate the edit to get the final content using the exact same logic as the tool
        return replace_all
          ? file.replaceAll(actualOldString, new_string)
          : file.replace(actualOldString, new_string)
      },
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    return { result: true, meta: { actualOldString } }
  },
  inputsEquivalent(input1, input2) {
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  async call(
    input: FileEditInput,
    {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path, old_string, new_string, replace_all = false } = input

    // 1. Get current state
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)
    // Remember this dir so later commands can find files here from another cwd.
    recordVisitedDir(dirname(absoluteFilePath))

    // Discover skills from this file's path (fire-and-forget, non-blocking)
    // Skip in simple mode - no skills available
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // Store discovered dirs for attachment display
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // Don't await - let skill loading happen in the background
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // Activate conditional skills whose path patterns match this file
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // These awaits must stay OUTSIDE the critical section below — a yield between
    // the staleness check and writeTextContent lets concurrent edits interleave.
    await fs.mkdir(dirname(absoluteFilePath))
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // 2. Load current state and confirm no changes since last read
    // Please avoid async operations between here and writing to disk to preserve atomicity
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    if (fileExists) {
      const lastWriteTime = getFileModificationTime(absoluteFilePath)
      const lastRead = readFileState.get(absoluteFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        const contentUnchanged =
          isFullRead && originalFileContents === lastRead.content
        if (!contentUnchanged) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // 3. Resolve old_string against the file's real content: exact /
    // quote-normalized first, then the whitespace-flexible fallback. Must
    // mirror validateInput, which approved this edit via the same resolution.
    const exactOrQuoteMatch = findActualString(originalFileContents, old_string)
    let actualOldString: string
    let actualNewString: string
    let flexMatchType: FlexibleMatchType | undefined
    if (exactOrQuoteMatch !== null) {
      actualOldString = exactOrQuoteMatch
      // Preserve curly quotes in new_string when the file uses them
      actualNewString = preserveQuoteStyle(
        old_string,
        actualOldString,
        new_string,
      )
    } else {
      const flex = resolveFlexibleMatch(
        originalFileContents,
        old_string,
        new_string,
      )
      if (flex) {
        actualOldString = flex.actualOldString
        actualNewString = flex.actualNewString
        flexMatchType = flex.matchType
      } else {
        // No safe resolution — fall through with the raw strings; the no-op /
        // "String not found" handling below keeps prior behavior.
        actualOldString = old_string
        actualNewString = new_string
      }
    }

    // 4. Generate patch
    const { patch, updatedFile } = getPatchForEdit({
      filePath: absoluteFilePath,
      fileContents: originalFileContents,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    // Idempotent no-op: the resolved edit leaves the file byte-for-byte
    // identical (old_string === new_string, or new_string already equals the
    // matched text). Skip the write and every downstream side effect — LSP
    // didChange/didSave, the VSCode diff, file-history, analytics — since
    // nothing changed, and return a result that says so plainly so the model
    // moves on instead of re-issuing the same edit. Guarded on fileExists so
    // creating a brand-new empty file (originalFileContents === '' with the
    // file absent) is never mistaken for a no-op and dropped.
    if (fileExists && updatedFile === originalFileContents) {
      readFileState.set(absoluteFilePath, {
        ...carriedReadState(readFileState.get(absoluteFilePath)),
        content: originalFileContents,
        timestamp: getFileModificationTime(absoluteFilePath),
        offset: undefined,
        limit: undefined,
      })
      return {
        data: {
          filePath: file_path,
          oldString: actualOldString,
          newString: new_string,
          originalFile: originalFileContents,
          structuredPatch: patch,
          userModified: userModified ?? false,
          replaceAll: replace_all,
          noOp: true,
        },
      }
    }

    // 5. Write to disk
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // Notify LSP servers about file modification (didChange) and save (didSave)
    const lspManager = getLspServerManager()
    if (lspManager) {
      // Clear previously delivered diagnostics so new ones will be shown
      clearDeliveredDiagnosticsForFile(pathToFileURL(absoluteFilePath).href)
      // didChange: Content has been modified
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave: File has been saved to disk (triggers diagnostics in TypeScript server)
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // Notify VSCode about the file change for diff view
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // 6. Update read timestamp, to invalidate stale writes
    readFileState.set(absoluteFilePath, {
      ...carriedReadState(readFileState.get(absoluteFilePath)),
      content: updatedFile,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 7. Log events
    if (absoluteFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }
    countLinesChanged(patch)

    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    logEvent('tengu_edit_string_lengths', {
      oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
      newStringBytes: Buffer.byteLength(new_string, 'utf8'),
      replaceAll: replace_all,
    })

    // Track how often the whitespace-flexible fallback rescued an edit that
    // exact matching would have failed. (Metadata values are boolean-only by
    // policy — no strings.)
    if (flexMatchType) {
      logEvent('tengu_edit_flexible_match', {
        trailingWhitespace: flexMatchType === 'trailing-whitespace',
        indent: flexMatchType === 'indent',
      })
    }

    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(absoluteFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isEditTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // Best-effort, non-blocking syntax check (warn-only). Runs AFTER the write
    // above, so it is structurally incapable of blocking or reverting the edit —
    // it only attaches an advisory note when the edit INTRODUCED new parse
    // errors. Returns undefined for unsupported languages or unavailable
    // parsing, and never throws.
    const syntaxWarning = await validateEditSyntax(
      absoluteFilePath,
      originalFileContents,
      updatedFile,
    )
    if (syntaxWarning) {
      // Breadcrumb so the check is observable in a real session via --debug
      // (writes to ~/.claude/debug/<session>.txt; use -d2e for stderr).
      logForDebugging(`[tree-sitter] ${absoluteFilePath}: ${syntaxWarning}`)
    }

    // Same contract as the syntax check above, for named imports of Node
    // builtin modules (catches e.g. `import { fileURLToPath } from
    // 'node:path'` — wrong module — the instant it is written).
    const importWarning = validateBuiltinImports(
      absoluteFilePath,
      originalFileContents,
      updatedFile,
    )
    if (importWarning) {
      logForDebugging(`[import-check] ${absoluteFilePath}: ${importWarning}`)
    }

    // Show the model the post-edit region (bounded, line-numbered) in the
    // success result. This is the root-cause fix for chained-edit failures:
    // the model's next old_string for this file is built from the current
    // content it just saw, not a stale mental copy from before its own edit.
    // Opt out with CLAUDE_CODE_DISABLE_EDIT_SNIPPET=1 to save tokens.
    let editedSnippet: string | undefined
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EDIT_SNIPPET)) {
      const { formattedSnippet } = getSnippetForPatch(patch, updatedFile)
      if (formattedSnippet) {
        editedSnippet = capEditResultSnippet(formattedSnippet)
      }
    }

    // 8. Yield result
    const data = {
      filePath: file_path,
      oldString: actualOldString,
      newString: new_string,
      originalFile: originalFileContents,
      structuredPatch: patch,
      userModified: userModified ?? false,
      replaceAll: replace_all,
      ...(gitDiff && { gitDiff }),
      ...(syntaxWarning && { syntaxWarning }),
      ...(importWarning && { importWarning }),
      ...(editedSnippet && { editedSnippet }),
    }
    return {
      data,
    }
  },
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const {
      filePath,
      userModified,
      replaceAll,
      syntaxWarning,
      importWarning,
      editedSnippet,
      noOp,
    } = data

    const memoryWarning = getMemoryIndexWarning(filePath)
    const memorySuffix = memoryWarning ? `\n\n${memoryWarning}` : ''

    // No-op edit: nothing was written. Say so explicitly (and terminally) so
    // the model doesn't read "updated successfully" and loop trying to force a
    // change that is already in place. Covers both old_string === new_string
    // and the normalized already-applied case (old_string was missing but the
    // file already contained new_string).
    if (noOp) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No changes made to ${filePath}: the file already contains the requested text (the edit was a no-op or had already been applied). Nothing was written — do not retry this edit. If you intended a different change, Read the file and base old_string on its current content.${memorySuffix}`,
      }
    }

    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    const warnings = [syntaxWarning, importWarning]
      .filter(Boolean)
      .join('\n')
    const warningSuffix = warnings ? `\n\n${warnings}` : ''
    // Line numbers below the edit moved for every earlier read; say how far,
    // so a later ranged Read aims right without re-reading to find out.
    const shift = lineShiftAfterEdit(data.structuredPatch ?? [])
    const oldLineCount = data.originalFile
      ? data.originalFile.split('\n').length
      : 0
    const shiftNote =
      shift && shift.firstOldLine <= oldLineCount
        ? ` Lines below the edit moved ${shift.delta > 0 ? 'down' : 'up'} ${Math.abs(shift.delta)}: old line ${shift.firstOldLine} is now line ${shift.firstOldLine + shift.delta}.`
        : ''
    const snippetSuffix = editedSnippet
      ? `\n\nEdited region after the change (line-number prefixes are not file content — use these current lines, not your earlier read, for any follow-up old_string here):\n${editedSnippet}`
      : ''

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${shiftNote}${memorySuffix}${snippetSuffix}${warningSuffix}`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${shiftNote}${memorySuffix}${snippetSuffix}${warningSuffix}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

/**
 * Read-state fields an Edit keeps from the read it was based on. Earlier Read
 * results stay in the conversation, so their ranges stay reusable wherever
 * the text is unchanged (FileReadTool/rangeDedup.ts compares it).
 */
function carriedReadState(previous: FileState | undefined): {
  sourceMapsOmitted?: true
  seenRanges?: FileState['seenRanges']
} {
  return {
    ...(previous?.sourceMapsOmitted ? { sourceMapsOmitted: true as const } : {}),
    ...(previous?.seenRanges ? { seenRanges: previous.seenRanges } : {}),
  }
}

// Bounds for the file lines an Edit error shows.
const MAX_LISTED_MATCHES = 5
const STALE_CONTEXT_LINES = 3
const MAX_SHOWN_LINES = 40
const MAX_SHOWN_LINE_CHARS = 2000

function clipShownLine(line: string): string {
  return line.length > MAX_SHOWN_LINE_CHARS
    ? `${line.slice(0, MAX_SHOWN_LINE_CHARS)}… [${line.length - MAX_SHOWN_LINE_CHARS} more characters]`
    : line
}

function numberedLines(lines: string[], startLine: number): string {
  return addLineNumbers({
    content: lines.map(clipShownLine).join('\n'),
    startLine,
  })
}

/** Names the first line where old_string parts from the file, or ''. */
function differenceSummary(
  mismatch: OldStringMismatch | null,
  oldString: string,
): string {
  const d = mismatch?.difference
  if (!mismatch || !d) {
    return ''
  }
  const total = oldString.replace(/\n$/, '').split('\n').length
  const where =
    mismatch.matchedLines > 0
      ? `Your old_string (${total} lines) matches the file from line ${mismatch.regionStart} to ${d.line - 1}, then differs at line ${d.line}`
      : `Your old_string (${total} lines) is closest to the lines from ${mismatch.regionStart}, and differs at line ${d.line}`
  const show = (line: string | undefined) =>
    line === undefined
      ? '(end of file)'
      : d.whitespaceOnly
        ? JSON.stringify(line)
        : line.trim()
  return `${where}${d.whitespaceOnly ? ' (whitespace only)' : ''}:\n  file:       ${show(d.file)}\n  old_string: ${show(d.oldString)}\n`
}

/** The not-found hint for a file too large to show whole. */
function retryHintFromMismatch(
  mismatch: OldStringMismatch,
  oldString: string,
): string {
  const shown = numberedLines(mismatch.lines, mismatch.startLine)
  if (!mismatch.difference) {
    return `\nThe file's current content differs from your old_string — it has likely changed since you last read it (your own earlier edit, a formatter, or the user). Closest match currently in the file (line number prefixes are NOT part of the content):\n${shown}\nRetry with old_string copied exactly from these lines, or Read the file first if this is not the region you meant.`
  }
  const last = mismatch.startLine + mismatch.lines.length - 1
  return `\n${differenceSummary(mismatch, oldString)}Current lines ${mismatch.startLine}-${last} (line number prefixes are NOT part of the content):\n${shown}\nCorrect old_string from these lines and retry: the lines you change plus 2-3 lines of context is enough.`
}

/**
 * The refusal for an Edit whose read went stale: the lines the model read
 * changed on disk. Shows the current lines where the edit lands (the whole
 * file when small) and records them as the model's read, a partial view that
 * Edit accepts only through an exact old_string match, so the retry needs no
 * separate Read. Undefined when nothing useful can be shown.
 */
function staleReadRefusal(
  fullFilePath: string,
  context: ToolUseContext,
  current: string,
  timestamp: number,
  oldString: string,
  previous: FileState,
): string | undefined {
  const whole = current.length <= 2000
  let shown: { lines: string[]; startLine: number } | null
  if (whole) {
    shown = { lines: current.split('\n'), startLine: 1 }
  } else {
    const at = occurrenceLines(current, oldString, 1)[0]
    if (at === undefined) {
      shown = describeOldStringMismatch(current, oldString)
    } else {
      const fileLines = current.split('\n')
      const count = oldString.replace(/\n$/, '').split('\n').length
      const from = Math.max(1, at - STALE_CONTEXT_LINES)
      const to = Math.min(
        fileLines.length,
        at + count - 1 + STALE_CONTEXT_LINES,
        from + MAX_SHOWN_LINES - 1,
      )
      shown = { lines: fileLines.slice(from - 1, to), startLine: from }
    }
  }
  if (!shown) {
    return undefined
  }
  context.readFileState.set(fullFilePath, {
    content: current,
    timestamp,
    offset: undefined,
    limit: undefined,
    ...(whole ? {} : { isPartialView: true }),
    ...carriedReadState(previous),
  })
  recordFileRead(fullFilePath, context.agentId)
  noteFileRead(fullFilePath)
  const last = shown.startLine + shown.lines.length - 1
  const scope = whole
    ? 'Its current content now counts as your read'
    : `Current lines ${shown.startLine}-${last}, where your edit lands, now count as your read`
  return `File has been modified since read (by the user, a linter or another tool), so nothing was changed. ${scope} (line-number prefixes are not file content):\n${numberedLines(shown.lines, shown.startLine)}\nBase old_string on these lines and edit again.`
}

function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
