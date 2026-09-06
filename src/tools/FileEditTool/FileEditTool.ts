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
  type FlexibleMatchType,
  isEditLikelyAlreadyApplied,
  resolveFlexibleMatch,
} from './matchResolver.js'
import { getEditToolDescription } from './prompt.js'
import { noteFileRead, shouldBlockUnreadEdit } from './readFirstGuard.js'
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
      // A real read exists (full or windowed) — clear any stale blind-edit block
      // counter so a future blind edit of this file starts enforcement fresh.
      noteFileRead(fullFilePath)
    } else if (shouldBlockUnreadEdit(fullFilePath)) {
      // Read-before-Edit (matches FileWriteTool/NotebookEditTool). A blind edit —
      // no prior Read of this file this session — is blocked so the model reads
      // first and its old_string is copied from real content instead of guessed,
      // which prevents the wrong-old_string "String to replace not found" churn.
      // This returns to the MODEL as a <tool_use_error> tool_result (never a user
      // prompt), so the model self-corrects by reading, then retrying. The block
      // is BOUNDED by shouldBlockUnreadEdit: after a couple of blocks on the same
      // file it returns false and we fall through to seeding below — so a model
      // that ignores the error can never loop forever. New-file creation
      // (old_string === '') returned earlier, so it never reaches here.
      return {
        result: false,
        message:
          "File has not been read yet. Read it first with the Read tool before editing it — your old_string must match the file's exact current contents character-for-character.",
        errorCode: 6,
      }
    }

    // Seed a full read-state when there is no full read yet: either the model
    // read only a window (Read with offset/limit), or it never read the file but
    // the loop guard above is exhausted (degrade-to-proceed so repeated blind
    // edits can't loop). Both proceed; safety is still enforced by the old_string
    // match below — a region the model never saw fails with "String to replace
    // not found", never a silent clobber. Preserves the prior read-state cache
    // behavior for the partial-view case.
    if (!readTimestamp || readTimestamp.isPartialView) {
      const seeded = {
        content: fileContent,
        timestamp: getFileModificationTime(fullFilePath),
        offset: undefined,
        limit: undefined,
      }
      toolUseContext.readFileState.set(fullFilePath, seeded)
      readTimestamp = seeded
    }

    // Check if file exists and get its last modified time
    if (readTimestamp) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > readTimestamp.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        const isFullRead =
          readTimestamp.offset === undefined &&
          readTimestamp.limit === undefined
        if (isFullRead && fileContent === readTimestamp.content) {
          // Content unchanged, safe to proceed
        } else {
          return {
            result: false,
            behavior: 'ask',
            message:
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
        return {
          result: false,
          behavior: 'ask',
          message: `String to replace not found in file, but new_string is already present — this edit has most likely ALREADY been applied (e.g. by your own earlier edit). Do not retry the same edit. If you intended a different change, Read the file and base old_string on its current content.\nString: ${old_string}`,
          meta: {
            isFilePathAbsolute: String(isAbsolute(file_path)),
          },
          errorCode: 11,
        }
      }

      // Anchor the retry: models that edited blind (or against a stale view)
      // keep guessing old_string variants and loop. Show real current content
      // — the whole file when small, else the closest-matching region — so
      // the next attempt copies it exactly instead of guessing again.
      let recoveryHint: string
      if (file.length <= 2000) {
        recoveryHint = `\nCurrent file content:\n${file}`
      } else {
        const closest = describeClosestMatch(file, old_string)
        recoveryHint = closest
          ? `\nThe file's current content differs from your old_string — it has likely changed since you last read it (your own earlier edit, a formatter, or the user). Closest match currently in the file (line number prefixes are NOT part of the content):\n${addLineNumbers(
              {
                content: closest.lines.join('\n'),
                startLine: closest.startLine,
              },
            )}\nRetry with old_string copied exactly from these lines, or Read the file first if this is not the region you meant.`
          : '\nRead the file with the Read tool to see its current content, then retry with an exact, character-for-character old_string.'
      }
      return {
        result: false,
        behavior: 'ask',
        message: `String to replace not found in file.\nString: ${old_string}\n${recoveryHint}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    const matches = file.split(actualOldString).length - 1

    // Check if we have multiple matches but replace_all is false
    if (matches > 1 && !replace_all) {
      return {
        result: false,
        behavior: 'ask',
        message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
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

    // No-op edit: nothing was written. Say so explicitly (and terminally) so
    // the model doesn't read "updated successfully" and loop trying to force a
    // change that is already in place. Covers both old_string === new_string
    // and the normalized already-applied case (old_string was missing but the
    // file already contained new_string).
    if (noOp) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No changes made to ${filePath}: the file already contains the requested text (the edit was a no-op or had already been applied). Nothing was written — do not retry this edit. If you intended a different change, Read the file and base old_string on its current content.`,
      }
    }

    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''
    const warnings = [syntaxWarning, importWarning]
      .filter(Boolean)
      .join('\n')
    const warningSuffix = warnings ? `\n\n${warnings}` : ''
    const snippetSuffix = editedSnippet
      ? `\n\nEdited region after the change (line-number prefixes are not file content — use these current lines, not your earlier read, for any follow-up old_string here):\n${editedSnippet}`
      : ''

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.${snippetSuffix}${warningSuffix}`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.${snippetSuffix}${warningSuffix}`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

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
