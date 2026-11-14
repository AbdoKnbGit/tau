import { randomUUID } from 'crypto'
import { constants } from 'fs'
import { copyFile, writeFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path'
import type { AgentId, SessionId } from 'src/types/ids.js'
import type { LogOption } from 'src/types/logs.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemFileSnapshotMessage,
  UserMessage,
} from 'src/types/message.js'
import { getPlanSlugCache, getSessionId } from '../bootstrap/state.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isENOENT } from './errors.js'
import { getEnvironmentKind } from './filePersistence/outputsScanner.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { getInitialSettings } from './settings/settings.js'
import { generateWordSlug } from './words.js'
import { rebasePlanFileHistorySnapshots } from './fileHistory.js'
import { getTranscriptPathForSession } from './sessionStorage.js'
import {
  isPlanMainPath,
  isPlanMarkdownName,
  isPlanFilePathCandidate,
  isValidPlanId,
  parsePlanFileReference,
  planFileReference,
  readPlanFileRecord,
  recoverStoredPlanFile,
  renameStoredPlanFile,
  reservePlanIdentity,
  restorePlanFileReference,
  retiredPlanPathReplacement,
  samePlanDirectory,
  samePlanPath,
  setPlanFileLockReporter,
  withPlanFileLock,
  type PlanFileReference,
  type PlanFilenameChange,
} from './planFileStorage.js'

setPlanFileLockReporter(message =>
  logForDebugging(message, { level: 'error' }),
)

const MAX_SLUG_RETRIES = 10

/**
 * Get or generate a word slug for the current session's plan.
 * The slug is generated lazily on first access and cached for the session.
 * Reserve the namespace before the first write. After ten word collisions,
 * use a UUID rather than returning an occupied filename.
 */
export function getPlanSlug(sessionId?: SessionId): string {
  const id = sessionId ?? getSessionId()
  const cache = getPlanSlugCache()
  let slug = cache.get(id)
  if (!slug) {
    const plansDir = getPlansDirectory()
    try {
      // Try to find a unique slug that doesn't conflict with existing files
      for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
        slug = generateWordSlug()
        if (reservePlanIdentity(plansDir, slug)) {
          break
        }
        slug = undefined
      }
      // Exhausting word candidates must not select an occupied plan.
      for (let i = 0; !slug && i < MAX_SLUG_RETRIES; i++) {
        const candidate = `plan-${randomUUID()}`
        if (reservePlanIdentity(plansDir, candidate)) slug = candidate
      }
      if (!slug) throw new Error('Could not reserve a plan identity')
    } catch (error) {
      // Filename publication is optional. Path inspection must remain usable
      // on read-only/configuration-restricted filesystems; mutations still
      // require their normal permissions and plan-lock checks.
      logError(error)
      slug = `plan-${randomUUID()}`
    }
    cache.set(id, slug)
  }
  return slug!
}

/**
 * Set a specific plan slug for a session (used when resuming a session)
 */
export function setPlanSlug(sessionId: SessionId, slug: string): void {
  if (!isValidPlanId(slug)) {
    logError(new Error('Invalid saved plan identity'))
    return
  }
  getPlanSlugCache().set(sessionId, slug)
}

/**
 * Clear the plan slug for the current session.
 * This should be called on /clear to ensure a fresh plan file is used.
 */
export function clearPlanSlug(sessionId?: SessionId): void {
  const id = sessionId ?? getSessionId()
  getPlanSlugCache().delete(id)
}

/**
 * Clear ALL plan slug entries (all sessions).
 * Use this on /clear to free sub-session slug entries.
 */
export function clearAllPlanSlugs(): void {
  getPlanSlugCache().clear()
}

// Memoized: called from render bodies (FileReadTool/FileEditTool/FileWriteTool UI.tsx)
// and permission checks. Settings are stable; cwd-dependent entries are cleared
// at session/worktree transitions. Without memoization, each rendered tool
// message triggers a mkdirSync syscall (regressed in #20005). Worktree and
// resume transitions explicitly clear this directory cache when cwd changes.
function getPlansDirectoryForCwd(cwd: string): string {
  const settings = getInitialSettings()
  const settingsDir = settings.plansDirectory
  let plansPath: string

  if (settingsDir) {
    // Settings.json (relative to project root)
    const resolved = resolve(cwd, settingsDir)
    const fromRoot = relative(cwd, resolved)

    // Validate path stays within project root to prevent path traversal
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      logError(
        new Error(`plansDirectory must be within project root: ${settingsDir}`),
      )
      plansPath = join(getClaudeConfigHomeDir(), 'plans')
    } else {
      plansPath = resolved
    }
  } else {
    // Default
    plansPath = join(getClaudeConfigHomeDir(), 'plans')
  }

  // Ensure directory exists (mkdirSync with recursive: true is a no-op if it exists)
  try {
    getFsImplementation().mkdirSync(plansPath)
  } catch (error) {
    logError(error)
  }

  return plansPath
}

export const getPlansDirectory = memoize(() =>
  getPlansDirectoryForCwd(getCwd()),
)

/** Resolve source files before the caller switches into a saved worktree. */
function getSavedPlansDirectory(log: LogOption): string {
  const savedCwd = log.worktreeSession?.worktreePath ?? log.projectPath
  if (getInitialSettings().plansDirectory && savedCwd && isAbsolute(savedCwd)) {
    try {
      if (getFsImplementation().statSync(savedCwd).isDirectory()) {
        return getPlansDirectoryForCwd(savedCwd)
      }
    } catch {
      // Portable sessions may refer to a project absent on this machine.
    }
  }
  return getPlansDirectory()
}

/**
 * Get the file path for a session's plan
 * @param agentId Optional agent ID for subagents. If not provided, returns main session plan.
 * The session slug is immutable; the main filename can change on approval.
 * For subagents (agentId provided), returns {planSlug}-agent-{agentId}.md
 */
export function getPlanFilePath(agentId?: AgentId): string {
  const planSlug = getPlanSlug(getSessionId())

  if (!agentId) {
    try {
      return join(
        getPlansDirectory(),
        readPlanFileRecord(getPlansDirectory(), planSlug).filename,
      )
    } catch (error) {
      // Display/read callers remain usable; mutation checks below fail closed
      // when the metadata is unreadable instead of creating a replacement plan.
      logError(error)
      return join(getPlansDirectory(), `${planSlug}.md`)
    }
  }

  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(agentId))
    throw new Error('Invalid plan agent identity')
  // Subagent paths deliberately retain the immutable family slug.
  return join(getPlansDirectory(), `${planSlug}-agent-${agentId}.md`)
}

export type PlanFileOwner = {
  sessionId: SessionId
  planId: string
  directory: string
}

export function capturePlanFileOwner(): PlanFileOwner {
  return {
    sessionId: getSessionId(),
    planId: getPlanSlug(),
    directory: getPlansDirectory(),
  }
}

export function isPlanFileOwnerCurrent(owner: PlanFileOwner): boolean {
  return (
    owner.sessionId === getSessionId() &&
    getPlanSlugCache().get(owner.sessionId) === owner.planId &&
    samePlanDirectory(owner.directory, getPlansDirectory())
  )
}

type PlanFileRenameNotice = {
  owner: PlanFileOwner
  oldPath: string
  newPath: string
  /** The screen has drawn this rename; only the model still needs it. */
  shownToUser?: boolean
}

let pendingPlanFileRenameNotices: PlanFileRenameNotice[] = []
const planFileRenameNoticeListeners = new Set<() => void>()

/**
 * Hear about each rename as it is recorded. The screen uses this to show a
 * rename while the session is idle. Nothing here reaches the model.
 */
export function onPlanFileRenameNotice(listener: () => void): () => void {
  planFileRenameNoticeListeners.add(listener)
  return () => {
    planFileRenameNoticeListeners.delete(listener)
  }
}

/**
 * Hold a rename for the session's next model request. Unlike a queued
 * command, a pending notice never starts a model turn of its own.
 */
export function addPlanFileRenameNotice(notice: PlanFileRenameNotice): void {
  pendingPlanFileRenameNotices.push(notice)
  for (const listener of [...planFileRenameNoticeListeners]) {
    try {
      listener()
    } catch (error) {
      logError(error)
    }
  }
}

/**
 * The current session's renames the screen has not drawn yet. They stay
 * pending for the model, marked so that its request does not draw them again.
 * A turn can end without another request, and a rename can land while the
 * session is idle; without this the user would not see it until they type.
 */
export function showPlanFileRenameNotices(): Array<{ newPath: string }> {
  const fresh = pendingPlanFileRenameNotices.filter(
    notice => !notice.shownToUser && isPlanFileOwnerCurrent(notice.owner),
  )
  for (const notice of fresh) notice.shownToUser = true
  return fresh.map(({ newPath }) => ({ newPath }))
}

/** Drop notices for sessions that are no longer current, or all of them. */
export function discardPlanFileRenameNotices(all = false): void {
  pendingPlanFileRenameNotices = all
    ? []
    : pendingPlanFileRenameNotices.filter(notice =>
        isPlanFileOwnerCurrent(notice.owner),
      )
}

/** Hand the current session's undelivered renames to one model request. */
export function takePlanFileRenameNotices(): Array<{
  oldPath: string
  newPath: string
  shownToUser?: true
}> {
  const current = pendingPlanFileRenameNotices.filter(notice =>
    isPlanFileOwnerCurrent(notice.owner),
  )
  pendingPlanFileRenameNotices = []
  return current.map(({ oldPath, newPath, shownToUser }) => ({
    oldPath,
    newPath,
    ...(shownToUser ? { shownToUser: true as const } : {}),
  }))
}

/** The main plan reference, without creating a plan identity for the session. */
export function getCurrentPlanFileReference(): PlanFileReference | undefined {
  const planId = getPlanSlugCache().get(getSessionId())
  if (!planId) return undefined
  try {
    return planFileReference(readPlanFileRecord(getPlansDirectory(), planId))
  } catch (error) {
    logError(error)
    return undefined
  }
}

export function isCurrentSessionPlanFile(path: string): boolean {
  // Runs in permission checks for every path: reject non-Markdown first.
  if (!isPlanMarkdownName(path)) return false
  // A session without a plan identity owns no plan file. A permission check
  // must not create one (and reserve its name on disk) as a side effect.
  const id = getPlanSlugCache().get(getSessionId())
  if (!id) return false
  const directory = getPlansDirectory()
  if (!samePlanDirectory(dirname(path), directory)) return false
  let record
  try {
    record = readPlanFileRecord(directory, id)
  } catch (error) {
    logError(error)
    return false
  }
  try {
    if (!getFsImplementation().lstatSync(path).isFile()) return false
  } catch (error) {
    if (!isENOENT(error)) return false
  }
  if (isPlanMainPath(directory, record, path)) return true
  const prefix = `${id}-agent-`
  const name = basename(path)
  return (
    name.startsWith(prefix) &&
    name.endsWith('.md') &&
    /^[a-zA-Z0-9_-]{1,160}$/.test(name.slice(prefix.length, -3))
  )
}

/** Display plan controls only for this session's main/agent paths, including history. */
export function isPlanFileForDisplay(path: string): boolean {
  const planId = getPlanSlugCache().get(getSessionId())
  if (!planId) return false
  try {
    const absolutePath = resolve(getCwd(), path)
    if (!isPlanMarkdownName(absolutePath)) return false
    const name = basename(absolutePath)
    const directory = getPlansDirectory()
    const record = readPlanFileRecord(directory, planId)
    // Called while rendering every file message. Compare names first so
    // unrelated Markdown never pays for resolving its directory.
    const prefix = `${planId}-agent-`
    const isAgentName =
      name.startsWith(prefix) &&
      name.endsWith('.md') &&
      /^[a-zA-Z0-9_-]{1,160}$/.test(name.slice(prefix.length, -3))
    const key = (value: string) => value.normalize('NFC').toLowerCase()
    if (
      !isAgentName &&
      ![record.filename, ...record.previousFilenames].some(
        known => key(known) === key(name),
      )
    )
      return false
    if (!samePlanDirectory(directory, dirname(absolutePath))) return false
    // A reserved collision candidate can still be an unrelated existing file.
    // Only actual main/history names and the immutable agent family get previews.
    return (
      isAgentName ||
      isPlanMainPath(directory, record, absolutePath) ||
      !!retiredPlanPathReplacement(directory, record, absolutePath)
    )
  } catch {
    // Optional preview controls must not break ordinary file message rendering.
    return false
  }
}

export function getRetiredPlanPathReplacement(
  path: string,
): string | undefined {
  const id = getPlanSlugCache().get(getSessionId())
  if (!id) return undefined
  const target = resolvePlanMutationPath(path)
  if (!target || !isPlanMarkdownName(target)) return undefined
  path = target
  if (!samePlanDirectory(dirname(path), getPlansDirectory())) return undefined
  if (!isPlanFilePathCandidate(getPlansDirectory(), id, path)) return undefined
  return retiredPlanPathReplacement(
    getPlansDirectory(),
    readPlanFileRecord(getPlansDirectory(), id),
    path,
  )
}

/** Follow file aliases even after rename leaves their final target missing. */
function resolvePlanMutationPath(path: string): string | undefined {
  const fs = getFsImplementation()
  const visited = new Set<string>()
  for (let depth = 0; depth < 40; depth++) {
    // Do not introduce network probes while inspecting an alias.
    if (path.startsWith('//') || path.startsWith('\\\\')) return undefined
    if (visited.has(path)) break
    visited.add(path)
    try {
      if (!fs.lstatSync(path).isSymbolicLink()) break
      path = resolve(dirname(path), fs.readlinkSync(path))
    } catch {
      break
    }
  }
  return path
}

export function getPlanHistoryPath(path: string): string {
  const id = getPlanSlugCache().get(getSessionId())
  if (!id) return path
  const target = resolvePlanMutationPath(path)
  if (
    !target ||
    !isPlanMarkdownName(target) ||
    !samePlanDirectory(dirname(target), getPlansDirectory())
  )
    return path
  if (!isPlanFilePathCandidate(getPlansDirectory(), id, target)) return path
  const record = readPlanFileRecord(getPlansDirectory(), id)
  return isPlanMainPath(getPlansDirectory(), record, target) ||
    retiredPlanPathReplacement(getPlansDirectory(), record, target)
    ? join(getPlansDirectory(), `${id}.md`)
    : path
}

/** Serialize only plan mutations; unrelated file operations retain their behavior. */
export async function withPlanFileMutation<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const id = getPlanSlugCache().get(getSessionId())
  if (!id) return operation()
  const mutationPath = resolvePlanMutationPath(path)
  if (
    !mutationPath ||
    !isPlanMarkdownName(mutationPath) ||
    !samePlanDirectory(dirname(mutationPath), getPlansDirectory())
  )
    return operation()
  const directory = getPlansDirectory()
  if (!isPlanFilePathCandidate(directory, id, mutationPath)) return operation()
  const assertCurrentPath = () => {
    if (
      getPlanSlugCache().get(getSessionId()) !== id ||
      !samePlanDirectory(directory, getPlansDirectory())
    ) {
      throw new Error(
        'The plan session changed before its file operation could complete',
      )
    }
    const currentTarget = resolvePlanMutationPath(path)
    if (!currentTarget || !samePlanPath(currentTarget, mutationPath)) {
      throw new Error(
        'The plan file alias changed before its file operation could complete',
      )
    }
    const replacement = retiredPlanPathReplacement(
      directory,
      readPlanFileRecord(directory, id),
      mutationPath,
    )
    if (replacement)
      throw new Error(
        `The plan file moved to ${replacement}. Read the current file before editing it.`,
      )
  }
  assertCurrentPath()
  if (!isCurrentSessionPlanFile(mutationPath)) return operation()
  return withPlanFileLock(directory, id, async () => {
    assertCurrentPath()
    return operation()
  })
}

/** Approval-provided edits resolve their filename after acquiring the lock. */
export async function withCurrentPlanFileMutation<T>(
  agentId: AgentId | undefined,
  operation: (path: string) => Promise<T>,
): Promise<T> {
  const owner = capturePlanFileOwner()
  return withPlanFileLock(owner.directory, owner.planId, async () => {
    if (!isPlanFileOwnerCurrent(owner))
      throw new Error('The plan session changed before its edit could be saved')
    const path = agentId
      ? getPlanFilePath(agentId)
      : join(
          owner.directory,
          readPlanFileRecord(owner.directory, owner.planId).filename,
        )
    return operation(path)
  })
}

export async function renamePlanFileFromTitle(
  owner: PlanFileOwner,
  title: string,
): Promise<PlanFilenameChange> {
  let oldPath = join(owner.directory, `${owner.planId}.md`)
  try {
    oldPath = join(
      owner.directory,
      readPlanFileRecord(owner.directory, owner.planId).filename,
    )
    const { getCurrentSessionTitle, getTranscriptPath, savePlanFileReference } =
      await import('./sessionStorage.js')
    if (!isPlanFileOwnerCurrent(owner))
      return {
        status: 'skipped',
        oldPath,
        newPath: oldPath,
        reason: 'Stale plan approval',
      }
    const transcriptPath = getTranscriptPath()
    return await renameStoredPlanFile({
      ...owner,
      title,
      shouldProceed: () =>
        isPlanFileOwnerCurrent(owner) &&
        getCurrentSessionTitle(owner.sessionId) === title,
      persistReference: async (reference) => {
        await savePlanFileReference(
          owner.sessionId as import('crypto').UUID,
          reference,
          transcriptPath,
        )
        if (isPlanFileOwnerCurrent(owner)) await persistFileSnapshotIfRemote()
      },
    })
  } catch (error) {
    logError(error)
    // If publication committed but later persistence/cleanup failed, preserve
    // the authoritative new file and leave the old pathname for recovery.
    try {
      const record = readPlanFileRecord(owner.directory, owner.planId)
      const newPath = join(owner.directory, record.filename)
      return {
        status: samePlanPath(oldPath, newPath) ? 'skipped' : 'renamed',
        oldPath,
        newPath,
        reference: planFileReference(record),
        reason: 'The plan filename operation could not finish completely',
      }
    } catch {
      return {
        status: 'skipped',
        oldPath,
        newPath: oldPath,
        reason: 'The plan reference is unavailable',
      }
    }
  }
}

/**
 * Get the plan content for a session
 * @param agentId Optional agent ID for subagents. If not provided, returns main session plan.
 */
export function getPlan(agentId?: AgentId): string | null {
  // No identity means no plan file. Compaction asks this of every session;
  // do not create and reserve a plan identity just to look.
  if (!getPlanSlugCache().get(getSessionId())) return null
  try {
    // The display getter can fall back when metadata is unreadable. Actual
    // plan reads must verify ownership rather than read that fallback path.
    const filePath = agentId
      ? getPlanFilePath(agentId)
      : join(
          getPlansDirectory(),
          readPlanFileRecord(getPlansDirectory(), getPlanSlug()).filename,
        )
    return getFsImplementation().readFileSync(filePath, { encoding: 'utf-8' })
  } catch (error) {
    if (isENOENT(error)) return null
    logError(error)
    return null
  }
}

/**
 * Extract the plan slug from a log's message history.
 */
function getSlugFromLog(log: LogOption): string | undefined {
  return (
    getReferenceFromLog(log)?.planId ??
    log.messages.find((m) => isValidPlanId(m.slug))?.slug
  )
}

function getReferenceFromLog(log: LogOption): PlanFileReference | undefined {
  const saved = parsePlanFileReference(log.planFileReference)
  const family =
    saved?.planId ?? log.messages.find((m) => isValidPlanId(m.slug))?.slug
  let latest = saved
  for (let i = log.messages.length - 1; i >= 0; i--) {
    const message = log.messages[i] as unknown as {
      planFileReference?: unknown
      attachment?: { planFileReference?: unknown }
    }
    const reference = parsePlanFileReference(
      message.planFileReference ?? message.attachment?.planFileReference,
    )
    if (
      reference &&
      reference.planId === family &&
      (!latest || reference.revision > latest.revision)
    )
      latest = reference
  }
  return latest
}

/**
 * Restore plan slug from a resumed session.
 * Sets the slug in the session cache so getPlanSlug returns it.
 * If the plan file is missing, attempts to recover it from a file snapshot
 * (written incrementally during the session) or from message history.
 * Returns true if a plan file exists (or was recovered) for the slug.
 * @param log The log to restore from
 * @param targetSessionId The session ID to associate the plan slug with.
 *                        This should be the ORIGINAL session ID being resumed,
 *                        not the temporary session ID from before resume.
 */
export async function copyPlanForResume(
  log: LogOption,
  targetSessionId?: SessionId,
): Promise<boolean> {
  const slug = getSlugFromLog(log)
  if (!slug) {
    return false
  }

  // Set the slug for the target session ID (or current if not provided)
  const sessionId = targetSessionId ?? getSessionId()
  const directory = getSavedPlansDirectory(log)
  setPlanSlug(sessionId, slug)

  const reference = getReferenceFromLog(log) ?? {
    version: 1 as const,
    planId: slug,
    filename: `${slug}.md`,
    revision: 0,
  }
  {
    try {
      const restored = await restorePlanFileReference(
        directory,
        reference,
        findFileSnapshotEntry(log.messages, 'plan')?.content ??
          recoverPlanFromMessages(log) ??
          undefined,
      )
      log.planFileReference = planFileReference(restored)
      const { savePlanFileReference } = await import('./sessionStorage.js')
      if (
        log.fullPath ||
        (getSessionId() === sessionId &&
          samePlanDirectory(directory, getPlansDirectory()))
      ) {
        await savePlanFileReference(
          sessionId as import('crypto').UUID,
          log.planFileReference,
          log.fullPath,
        )
      }
    } catch (error) {
      logError(error)
      return false
    }
  }

  // Attempt to read the plan file directly — recovery triggers on ENOENT.
  let record
  try {
    record = await recoverStoredPlanFile(directory, slug)
  } catch (error) {
    logError(error)
    return false
  }
  log.planFileReference = planFileReference(record)
  const planPath = join(directory, record.filename)
  try {
    await getFsImplementation().readFile(planPath, { encoding: 'utf-8' })
    return true
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      // Don't throw — called fire-and-forget (void copyPlanForResume(...)) with no .catch()
      logError(e)
      return false
    }
    // Only attempt recovery in remote sessions (CCR) where files don't persist
    if (getEnvironmentKind() === null) {
      return false
    }

    logForDebugging(
      `Plan file missing during resume: ${planPath}. Attempting recovery.`,
    )

    // Try file snapshot first (written incrementally during session)
    const snapshotPlan = findFileSnapshotEntry(log.messages, 'plan')
    let recovered: string | null = null
    if (snapshotPlan && snapshotPlan.content.length > 0) {
      recovered = snapshotPlan.content
      logForDebugging(
        `Plan recovered from file snapshot, ${recovered.length} chars`,
        { level: 'info' },
      )
    } else {
      // Fall back to searching message history
      recovered = recoverPlanFromMessages(log)
      if (recovered) {
        logForDebugging(
          `Plan recovered from message history, ${recovered.length} chars`,
          { level: 'info' },
        )
      }
    }

    if (recovered) {
      try {
        await withPlanFileLock(directory, slug, async () => {
          const path = join(
            directory,
            readPlanFileRecord(directory, slug).filename,
          )
          try {
            await writeFile(path, recovered!, { encoding: 'utf-8', flag: 'wx' })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
        })
        return true
      } catch (writeError) {
        logError(writeError)
        return false
      }
    }
    logForDebugging(
      'Plan file recovery failed: no file snapshot or plan content found in message history',
    )
    return false
  }
}

/**
 * Copy a plan file for a forked session. Unlike copyPlanForResume (which reuses
 * the original slug), this generates a NEW slug for the forked session and
 * writes the original plan content to the new file. This prevents the original
 * and forked sessions from clobbering each other's plan files.
 */
export async function copyPlanForFork(
  log: LogOption,
  targetSessionId: SessionId,
): Promise<boolean> {
  const originalSlug = getSlugFromLog(log)
  if (!originalSlug) {
    return false
  }

  const plansDir = getSavedPlansDirectory(log)
  const targetDirectory = getPlansDirectory()
  // Reserve synchronously before the caller can start persisting the fork.
  const newSlug = getPlanSlug(targetSessionId)
  const targetTranscriptPath = getTranscriptPathForSession(targetSessionId)
  if (log.fileHistorySnapshots) {
    log.fileHistorySnapshots = rebasePlanFileHistorySnapshots(
      log.fileHistorySnapshots,
      originalSlug,
      newSlug,
      plansDir,
      log.projectPath,
      targetDirectory,
    )
  }
  const newPlanPath = join(targetDirectory, `${newSlug}.md`)
  let copied = false
  try {
    const reference = getReferenceFromLog(log)
    if (reference)
      await restorePlanFileReference(
        plansDir,
        reference,
        findFileSnapshotEntry(log.messages, 'plan')?.content ??
          recoverPlanFromMessages(log) ??
          undefined,
      )
    await withPlanFileLock(plansDir, originalSlug, async () => {
      const source = join(
        plansDir,
        readPlanFileRecord(plansDir, originalSlug).filename,
      )
      await copyFile(source, newPlanPath, constants.COPYFILE_EXCL)
    })
    copied = true
  } catch (error) {
    if (!isENOENT(error)) logError(error)
  }
  // Copied rows can still carry the source slug (/clone, /import). Record the
  // fork's own identity even when there was no plan to copy, so resuming the
  // fork later can never adopt, and then overwrite, the source's plan file.
  try {
    const { savePlanFileReference } = await import('./sessionStorage.js')
    await savePlanFileReference(
      targetSessionId as import('crypto').UUID,
      {
        version: 1,
        planId: newSlug,
        filename: `${newSlug}.md`,
        revision: 0,
      },
      targetTranscriptPath,
    )
  } catch (error) {
    logError(error)
  }
  return copied
}

/**
 * Recover plan content from the message history. Plan content can appear in
 * three forms depending on what happened during the session:
 *
 * 1. ExitPlanMode tool_use input — normalizeToolInput injects the plan content
 *    into the tool_use input, which persists in the transcript.
 *
 * 2. planContent field on user messages — set during the "clear context and
 *    implement" flow when ExitPlanMode is approved.
 *
 * 3. plan_file_reference attachment — created by auto-compact to preserve the
 *    plan across compaction boundaries.
 */
function recoverPlanFromMessages(log: LogOption): string | null {
  for (let i = log.messages.length - 1; i >= 0; i--) {
    const msg = log.messages[i]
    if (!msg) {
      continue
    }

    if (msg.type === 'assistant') {
      const { content } = (msg as AssistantMessage).message
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            block.name === EXIT_PLAN_MODE_V2_TOOL_NAME
          ) {
            const input = block.input as Record<string, unknown> | undefined
            const plan = input?.plan
            if (typeof plan === 'string' && plan.length > 0) {
              return plan
            }
          }
        }
      }
    }

    if (msg.type === 'user') {
      const userMsg = msg as UserMessage
      if (
        typeof userMsg.planContent === 'string' &&
        userMsg.planContent.length > 0
      ) {
        return userMsg.planContent
      }
    }

    if (msg.type === 'attachment') {
      const attachmentMsg = msg as AttachmentMessage
      if (attachmentMsg.attachment?.type === 'plan_file_reference') {
        const plan = (attachmentMsg.attachment as { planContent?: string })
          .planContent
        if (typeof plan === 'string' && plan.length > 0) {
          return plan
        }
      }
    }
  }
  return null
}

/**
 * Find a file entry in the most recent file-snapshot system message in the transcript.
 * Scans backwards to find the latest snapshot.
 */
function findFileSnapshotEntry(
  messages: LogOption['messages'],
  key: string,
): { key: string; path: string; content: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (
      msg?.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'file_snapshot' &&
      'snapshotFiles' in msg
    ) {
      const files = msg.snapshotFiles as Array<{
        key: string
        path: string
        content: string
      }>
      return files.find((f) => f.key === key)
    }
  }
  return undefined
}

/**
 * Persist a snapshot of session files (plan, todos) to the transcript.
 * Called incrementally whenever these files change. Only active in remote
 * sessions (CCR) where local files don't persist between sessions.
 */
export async function persistFileSnapshotIfRemote(): Promise<void> {
  if (getEnvironmentKind() === null) {
    return
  }
  try {
    const owner = capturePlanFileOwner()
    const snapshotFiles: SystemFileSnapshotMessage['snapshotFiles'] = []

    // Snapshot plan file
    const plan = getPlan()
    if (plan) {
      snapshotFiles.push({
        key: 'plan',
        path: getPlanFilePath(),
        content: plan,
      })
    }

    if (snapshotFiles.length === 0) {
      return
    }

    const message: SystemFileSnapshotMessage = {
      type: 'system',
      subtype: 'file_snapshot',
      content: 'File snapshot',
      level: 'info',
      isMeta: true,
      timestamp: new Date().toISOString(),
      uuid: randomUUID(),
      snapshotFiles,
      planFileReference: getCurrentPlanFileReference(),
    }

    const { recordTranscript } = await import('./sessionStorage.js')
    await recordTranscript([message], undefined, undefined, undefined, () =>
      isPlanFileOwnerCurrent(owner),
    )
  } catch (error) {
    logError(error)
  }
}
