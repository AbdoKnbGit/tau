import { randomUUID } from 'crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  linkSync,
  realpathSync,
} from 'fs'
import { basename, dirname, join, relative, resolve } from 'path'
import { lock } from './lockfile.js'

// This module stays free of app dependencies; plans.ts supplies the logger.
let reportPlanFileLockProblem: (message: string) => void = () => {}

export function setPlanFileLockReporter(report: (message: string) => void) {
  reportPlanFileLockProblem = report
}

/** The ID is permanent. Only the main plan's filename changes. */
export type PlanFileReference = {
  version: 1
  planId: string
  filename: string
  revision: number
}

type FileIdentity = { dev: string; ino: string }
export type PlanFileRecord = PlanFileReference & {
  previousFilenames: string[]
  cleanup?: { filename: string; identity: FileIdentity }
}

export class PlanFileOwnershipError extends Error {
  readonly code = 'EPLANOWNERSHIP'
}

const METADATA_DIRECTORY = '.plan-metadata'
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/
const SAFE_FILENAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}\.md$/u
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

export function isValidPlanId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function isSafeFilename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_FILENAME.test(value) &&
    Buffer.byteLength(value) <= 200 &&
    !RESERVED_DEVICE.test(value.slice(0, -3).normalize('NFKC'))
  )
}

export function parsePlanFileReference(
  value: unknown,
): PlanFileReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ref = value as Partial<PlanFileReference>
  if (
    ref.version !== 1 ||
    !isValidPlanId(ref.planId) ||
    !isSafeFilename(ref.filename) ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision! < 0
  )
    return undefined
  // Main filenames cannot impersonate the immutable subagent namespace.
  if (
    ref.filename !== `${ref.planId}.md` &&
    ref.filename.toLowerCase().includes('-agent-')
  )
    return undefined
  return {
    version: 1,
    planId: ref.planId,
    filename: ref.filename,
    revision: ref.revision!,
  }
}

export function planTitleToFilenameSlug(title: string): string | undefined {
  const normalized = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .map(word => (word === 'agent' ? 'agentplan' : word))
    .join('-')
  let slug = ''
  for (const character of normalized) {
    if (Buffer.byteLength(slug + character) > 100) break
    slug += character
  }
  slug = slug.replace(/-+$/g, '')
  if (!slug) return undefined
  return RESERVED_DEVICE.test(slug) ? `plan-${slug}` : slug
}

export function getPlanMetadataPath(directory: string, planId: string): string {
  if (!isValidPlanId(planId)) throw new Error('Invalid plan identity')
  return join(directory, METADATA_DIRECTORY, `${planId}.json`)
}

function legacyRecord(planId: string): PlanFileRecord {
  if (!isValidPlanId(planId)) throw new Error('Invalid plan identity')
  return {
    version: 1,
    planId,
    filename: `${planId}.md`,
    revision: 0,
    previousFilenames: [],
  }
}

/** Deliberately not memoized: another process can rename the shared plan. */
export function readPlanFileRecord(
  directory: string,
  planId: string,
): PlanFileRecord {
  const path = getPlanMetadataPath(directory, planId)
  let value: unknown
  try {
    if (!lstatSync(path).isFile())
      throw new Error('Plan metadata must be a regular file')
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const record = legacyRecord(planId)
      assertFilenameNotClaimedByAnotherPlan(directory, record.filename, planId)
      return record
    }
    throw error
  }
  const reference = parsePlanFileReference(value)
  const record = value as Partial<PlanFileRecord>
  if (
    !reference ||
    reference.planId !== planId ||
    !Array.isArray(record.previousFilenames) ||
    !record.previousFilenames.every(isSafeFilename)
  ) {
    throw new Error(`Invalid plan metadata for ${planId}`)
  }
  assertFilenameNotClaimedByAnotherPlan(directory, reference.filename, planId)
  let cleanup: PlanFileRecord['cleanup']
  if (record.cleanup !== undefined) {
    const entry = record.cleanup
    if (
      !isSafeFilename(entry.filename) ||
      entry.filename === reference.filename ||
      typeof entry.identity?.dev !== 'string' ||
      typeof entry.identity?.ino !== 'string' ||
      !/^\d+$/.test(entry.identity.dev) ||
      !/^\d+$/.test(entry.identity.ino) ||
      !record.previousFilenames.includes(entry.filename)
    ) {
      throw new Error(`Invalid plan cleanup metadata for ${planId}`)
    }
    cleanup = entry
  }
  return {
    ...reference,
    previousFilenames: [...new Set(record.previousFilenames)],
    ...(cleanup ? { cleanup } : {}),
  }
}

export function planFileReference(
  record: PlanFileReference,
): PlanFileReference {
  return {
    version: 1,
    planId: record.planId,
    filename: record.filename,
    revision: record.revision,
  }
}

function ensureMetadataDirectory(directory: string): void {
  const path = join(directory, METADATA_DIRECTORY)
  const created = mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error('Plan metadata directory must be a real directory')
  }
  if (created !== undefined) {
    // Records hold machine-local file identities. A plans directory inside a
    // repository must not offer them for commit.
    try {
      writeFileSync(join(path, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 })
    } catch {
      // Optional hygiene; plan operations do not depend on it.
    }
  }
}

function filenameOwnerPath(directory: string, filename: string): string {
  if (!isSafeFilename(filename)) throw new Error('Invalid plan filename')
  ensureMetadataDirectory(directory)
  const names = join(directory, METADATA_DIRECTORY, 'names')
  mkdirSync(names, { recursive: true, mode: 0o700 })
  if (!lstatSync(names).isDirectory() || lstatSync(names).isSymbolicLink()) {
    throw new Error('Plan filename registry must be a real directory')
  }
  return join(names, `${filename}.json`)
}

type FilenameOwner = { planId?: unknown; published?: unknown }

/**
 * reserveFilename creates a reservation empty and writes its owner right
 * after, so another process can read it in between. An empty reservation is
 * still being written: it has no owner yet, so it is never the caller's.
 */
function readFilenameOwner(path: string): FilenameOwner | undefined {
  if (!lstatSync(path).isFile())
    throw new Error('Plan filename ownership must be a regular file')
  const text = readFileSync(path, 'utf8')
  return text === '' ? undefined : (JSON.parse(text) as FilenameOwner)
}

function filenameOwnedBy(
  directory: string,
  filename: string,
  planId: string,
  requirePublished = true,
): boolean {
  try {
    // Reading ownership must not create metadata or require directory writes.
    const path = join(
      directory,
      METADATA_DIRECTORY,
      'names',
      `${filename}.json`,
    )
    const owner = readFilenameOwner(path)
    return (
      owner !== undefined &&
      owner.planId === planId &&
      (!requirePublished || owner.published === true)
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function assertFilenameNotClaimedByAnotherPlan(
  directory: string,
  filename: string,
  planId: string,
): void {
  const path = join(directory, METADATA_DIRECTORY, 'names', `${filename}.json`)
  try {
    const claimant = readFilenameOwner(path)?.planId
    if (isValidPlanId(claimant) && claimant !== planId) {
      throw new PlanFileOwnershipError(
        `The plan filename ${filename} belongs to another plan`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Only proven plan paths may depend on plan metadata or block on its failure. */
export function isPlanFilePathCandidate(
  directory: string,
  planId: string,
  path: string,
): boolean {
  // Plan names always end in .md; check that before any filesystem work.
  if (!isPlanMarkdownName(path)) return false
  if (!samePlanDirectory(dirname(path), directory)) return false
  const name = basename(path)
  if (samePlanPath(join(directory, `${planId}.md`), path)) return true
  const prefix = `${planId}-agent-`
  if (
    name.startsWith(prefix) &&
    /^[a-zA-Z0-9_-]{1,160}\.md$/.test(name.slice(prefix.length))
  )
    return true
  // A registry entry proves this is a managed pathname. Corruption there
  // must block its mutation rather than silently treating it as ordinary data.
  if (filenameOwnedBy(directory, name, planId, false)) return true
  try {
    const record = readPlanFileRecord(directory, planId)
    return (
      isPlanMainPath(directory, record, path) ||
      !!retiredPlanPathReplacement(directory, record, path)
    )
  } catch {
    // A corrupt sidecar for one plan must not disable arbitrary sibling files.
    return false
  }
}

/** Reservations also cover plan IDs whose first Markdown write has not happened. */
function reserveFilename(
  directory: string,
  filename: string,
  planId: string,
  allowSameOwner = false,
): boolean {
  const path = filenameOwnerPath(directory, filename)
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return allowSameOwner && filenameOwnedBy(directory, filename, planId, false)
  }
  try {
    writeFileSync(fd, JSON.stringify({ planId, published: false }) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(join(directory, METADATA_DIRECTORY, 'names'))
  return true
}

function publishFilename(
  directory: string,
  filename: string,
  planId: string,
): void {
  if (!filenameOwnedBy(directory, filename, planId, false))
    throw new Error('Plan filename reservation changed')
  atomicWriteJson(filenameOwnerPath(directory, filename), {
    planId,
    published: true,
  })
}

export function reservePlanIdentity(
  directory: string,
  planId: string,
): boolean {
  if (!isValidPlanId(planId)) throw new Error('Invalid plan identity')
  try {
    lstatSync(join(directory, `${planId}.md`))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    lstatSync(getPlanMetadataPath(directory, planId))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return reserveFilename(directory, `${planId}.md`, planId)
}

// Directory syncing is supported by some filesystems. File contents are always
// flushed; unsupported directory flushes do not trigger a destructive fallback.
function syncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = openSync(directory, constants.O_RDONLY)
    fsyncSync(fd)
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(value) + '\n', 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    syncDirectory(dirname(path))
  } finally {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function writeRecord(directory: string, record: PlanFileRecord): void {
  ensureMetadataDirectory(directory)
  atomicWriteJson(getPlanMetadataPath(directory, record.planId), record)
}

export async function withPlanFileLock<T>(
  directory: string,
  planId: string,
  operation: () => Promise<T>,
): Promise<T> {
  ensureMetadataDirectory(directory)
  const release = await lock(getPlanMetadataPath(directory, planId), {
    realpath: false,
    retries: { retries: 40, minTimeout: 10, maxTimeout: 250 },
    // The default handler throws from a timer, which ends the process. A lock
    // lost after an event-loop stall or system sleep is recoverable.
    onCompromised: error =>
      reportPlanFileLockProblem(`Plan file lock compromised: ${error}`),
  })
  try {
    return await operation()
  } finally {
    // The operation has already finished. A lock that cannot be removed
    // expires as stale; it must not turn a completed edit into a failure.
    await release().catch(error =>
      reportPlanFileLockProblem(`Plan file lock release failed: ${error}`),
    )
  }
}

export async function restorePlanFileReference(
  directory: string,
  value: PlanFileReference,
  content?: string,
): Promise<PlanFileRecord> {
  const reference = parsePlanFileReference(value)
  if (!reference) throw new Error('Invalid saved plan reference')
  return withPlanFileLock(directory, reference.planId, async () => {
    let current: PlanFileRecord
    let foreignFilename = false
    try {
      current = recoverRecord(
        directory,
        readPlanFileRecord(directory, reference.planId),
      )
    } catch (error) {
      if (!(error instanceof PlanFileOwnershipError)) throw error
      current = legacyRecord(reference.planId)
      foreignFilename = true
    }
    // A local manifest is authoritative, including a newer local filename that
    // an old portable snapshot cannot know about.
    try {
      lstatSync(getPlanMetadataPath(directory, reference.planId))
      if (
        !foreignFilename &&
        reserveFilename(directory, current.filename, reference.planId, true)
      )
        return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      !foreignFilename &&
      reference.filename === current.filename &&
      reserveFilename(directory, current.filename, reference.planId, true)
    )
      return current
    let filename = reference.filename
    let ownedTarget = false
    try {
      ownedTarget =
        filenameOwnedBy(directory, filename, reference.planId) &&
        lstatSync(join(directory, filename)).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!ownedTarget) {
      // Never adopt a merely matching human title on another machine. Restore
      // saved bytes into an exclusively allocated file owned by this identity.
      let recovered: string | Buffer | undefined = content
      try {
        const source = join(directory, `${reference.planId}.md`)
        assertFilenameNotClaimedByAnotherPlan(
          directory,
          `${reference.planId}.md`,
          reference.planId,
        )
        if (!foreignFilename && lstatSync(source).isFile())
          recovered = readFileSync(source)
      } catch (error) {
        if (
          !(error instanceof PlanFileOwnershipError) &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        )
          throw error
      }
      if (recovered === undefined)
        throw new Error(
          'Cannot restore an unowned named plan without saved plan contents',
        )
      let stem = ''
      for (const character of filename.slice(0, -3)) {
        if (Buffer.byteLength(stem + character) > 100) break
        stem += character
      }
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')
      let created = false
      for (let attempt = 0; attempt < 100; attempt++) {
        filename =
          attempt === 0
            ? reference.filename
            : `${stem}-${timestamp}${attempt === 1 ? '' : `-${attempt - 1}`}.md`
        if (!reserveFilename(directory, filename, reference.planId)) continue
        let fd: number
        try {
          fd = openSync(join(directory, filename), 'wx', 0o600)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw error
        }
        try {
          writeFileSync(fd, recovered, 'utf8')
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        publishFilename(directory, filename, reference.planId)
        created = true
        break
      }
      if (!created)
        throw new Error('Could not reserve a filename for the recovered plan')
      syncDirectory(directory)
    }
    const restored: PlanFileRecord = {
      ...reference,
      filename,
      revision:
        filename === reference.filename
          ? reference.revision
          : reference.revision + 1,
      previousFilenames: [
        ...new Set([
          ...current.previousFilenames,
          current.filename,
          reference.filename,
        ]),
      ].filter(name => name !== filename),
    }
    writeRecord(directory, restored)
    return restored
  })
}

function identityOf(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) throw new Error('Only regular plan files can be renamed')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  try {
    const actual = identityOf(path)
    return (
      actual.ino !== '0' &&
      actual.dev === identity.dev &&
      actual.ino === identity.ino
    )
  } catch {
    return false
  }
}

function finishCleanup(
  directory: string,
  record: PlanFileRecord,
): PlanFileRecord {
  if (!record.cleanup) return record
  const path = join(directory, record.cleanup.filename)
  // Never remove an old pathname replaced by an independent editor/writer.
  try {
    lstatSync(path)
    if (
      !sameIdentity(path, record.cleanup.identity) ||
      !sameIdentity(join(directory, record.filename), record.cleanup.identity)
    )
      return record
    unlinkSync(path)
    syncDirectory(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return record
  }
  const { cleanup: _, ...clean } = record
  writeRecord(directory, clean)
  return clean
}

/** Repair interrupted cleanup only when the surviving original is proven ours. */
function recoverRecord(
  directory: string,
  record: PlanFileRecord,
): PlanFileRecord {
  if (!record.cleanup) return record
  try {
    lstatSync(join(directory, record.filename))
    return finishCleanup(directory, record)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (
    !sameIdentity(
      join(directory, record.cleanup.filename),
      record.cleanup.identity,
    )
  )
    return record
  const recovered: PlanFileRecord = {
    version: 1,
    planId: record.planId,
    filename: record.cleanup.filename,
    revision: record.revision + 1,
    previousFilenames: [
      ...new Set([...record.previousFilenames, record.filename]),
    ].filter(filename => filename !== record.cleanup!.filename),
  }
  writeRecord(directory, recovered)
  return recovered
}

export async function recoverStoredPlanFile(
  directory: string,
  planId: string,
): Promise<PlanFileRecord> {
  return withPlanFileLock(directory, planId, async () =>
    recoverRecord(directory, readPlanFileRecord(directory, planId)),
  )
}

export type PlanFilenameChange = {
  status: 'renamed' | 'unchanged' | 'skipped'
  oldPath: string
  newPath: string
  reference?: PlanFileReference
  reason?: string
}

/** Publish without replacing a destination; metadata commits before old-name removal. */
export async function renameStoredPlanFile(options: {
  directory: string
  planId: string
  title: string
  shouldProceed: () => boolean
  persistReference: (reference: PlanFileReference) => Promise<void>
  now?: Date
}): Promise<PlanFilenameChange> {
  const { directory, planId, title, shouldProceed, persistReference } = options
  return withPlanFileLock(directory, planId, async () => {
    let record = readPlanFileRecord(directory, planId)
    const oldPath = join(directory, record.filename)
    const skipped = (reason: string): PlanFilenameChange => ({
      status: 'skipped',
      oldPath,
      newPath: oldPath,
      reason,
    })
    if (!shouldProceed())
      return skipped('The plan approval is no longer current')
    const slug = planTitleToFilenameSlug(title)
    if (!slug) return skipped('The generated title has no usable filename')
    const plainName = `${slug}.md`
    // A repeated approval must not rename the already-published collision variant.
    const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (
      record.filename === plainName ||
      new RegExp(`^${escapedSlug}-\\d{8}T\\d{6}Z(?:-\\d+)?\\.md$`).test(
        record.filename,
      )
    ) {
      await persistReference(planFileReference(record))
      record = finishCleanup(directory, record)
      return {
        status: 'unchanged',
        oldPath,
        newPath: oldPath,
        reference: planFileReference(record),
      }
    }
    const identity = identityOf(oldPath)
    if (!reserveFilename(directory, record.filename, planId, true))
      return skipped('The source filename belongs to another plan')
    const timestamp = (options.now ?? new Date())
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z')
    let filename: string | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate =
        attempt === 0
          ? plainName
          : `${slug}-${timestamp}${attempt === 1 ? '' : `-${attempt - 1}`}.md`
      if (!reserveFilename(directory, candidate, planId, true)) continue
      try {
        linkSync(oldPath, join(directory, candidate))
        filename = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    if (!filename) return skipped('No unused plan filename could be reserved')
    if (
      !sameIdentity(oldPath, identity) ||
      !sameIdentity(join(directory, filename), identity)
    ) {
      return skipped('The source plan changed during publication')
    }
    publishFilename(directory, filename, planId)
    syncDirectory(directory)
    const next: PlanFileRecord = {
      version: 1,
      planId,
      filename,
      revision: record.revision + 1,
      previousFilenames: [
        ...new Set([...record.previousFilenames, record.filename]),
      ].filter(name => name !== filename),
      cleanup: { filename: record.filename, identity },
    }
    if (!parsePlanFileReference(next))
      throw new Error('Invalid generated plan reference')
    // No event-loop yield between linking and committing: cooperating writers
    // also take this lock. An uncommitted link is left intact on failure.
    writeRecord(directory, next)
    await persistReference(planFileReference(next))
    record = finishCleanup(directory, next)
    return {
      status: 'renamed',
      oldPath,
      newPath: join(directory, filename),
      reference: planFileReference(record),
    }
  })
}

/** Plan files are always Markdown; reject anything else without touching disk. */
export function isPlanMarkdownName(path: string): boolean {
  return basename(path).toLowerCase().endsWith('.md')
}

/**
 * UNC (\\server\share), device (\\?\, \\.\) and //host paths. Inspecting one
 * can open a network connection and send credentials, so such paths are
 * compared by spelling only, like the permission checks that run before them.
 */
export function isPlanNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /^[\\/]{2}/.test(resolve(path))
}

/**
 * Case-insensitive filesystems (APFS and HFS+ on macOS, NTFS) open one file
 * under every case and Unicode spelling of its name, while realpath keeps the
 * spelling it was given. Two names in one directory are such spellings when
 * they differ only that way and open the same file. Hard links with other
 * names, like a plan's old and new name during a rename, stay distinct.
 */
function isFilesystemNameAlias(left: string, right: string): boolean {
  const fold = (name: string) => name.normalize('NFC').toLowerCase()
  if (fold(basename(left)) !== fold(basename(right))) return false
  try {
    return sameIdentity(right, identityOf(left))
  } catch {
    return false
  }
}

export function samePlanPath(left: string, right: string): boolean {
  if (isPlanNetworkPath(left) || isPlanNetworkPath(right))
    return relative(resolve(left), resolve(right)) === ''
  // Resolve directory aliases, but never follow a final file symlink when
  // deciding ownership. Missing retired filenames still resolve by their parent.
  const canonical = (path: string) => {
    const absolute = resolve(path)
    try {
      // lstat preserves the rule against following a final symbolic link.
      if (lstatSync(absolute).isFile()) return realpathSync(absolute)
    } catch {
      // Missing retired filenames still resolve by their parent below.
    }
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
  const leftPath = canonical(left)
  const rightPath = canonical(right)
  if (relative(leftPath, rightPath) === '') return true
  return (
    relative(dirname(leftPath), dirname(rightPath)) === '' &&
    isFilesystemNameAlias(leftPath, rightPath)
  )
}

/** Retired files are absent; their surviving reservations retain OS spelling. */
function isRegisteredFilenameAlias(
  directory: string,
  filename: string,
  path: string,
): boolean {
  if (!samePlanDirectory(directory, dirname(path))) return false
  const names = join(directory, METADATA_DIRECTORY, 'names')
  const expected = join(names, `${filename}.json`)
  const actual = join(names, `${basename(path)}.json`)
  try {
    if (!lstatSync(expected).isFile() || !lstatSync(actual).isFile())
      return false
    return (
      relative(realpathSync(expected), realpathSync(actual)) === '' ||
      isFilesystemNameAlias(expected, actual)
    )
  } catch {
    return false
  }
}

export function samePlanDirectory(left: string, right: string): boolean {
  if (isPlanNetworkPath(left) || isPlanNetworkPath(right))
    return relative(resolve(left), resolve(right)) === ''
  try {
    return relative(realpathSync(left), realpathSync(right)) === ''
  } catch {
    return relative(resolve(left), resolve(right)) === ''
  }
}

export function isPlanMainPath(
  directory: string,
  record: PlanFileRecord,
  path: string,
): boolean {
  return samePlanPath(join(directory, record.filename), path)
}

export function retiredPlanPathReplacement(
  directory: string,
  record: PlanFileRecord,
  path: string,
): string | undefined {
  if (
    record.previousFilenames.some(
      name =>
        samePlanPath(join(directory, name), path) ||
        isRegisteredFilenameAlias(directory, name, path),
    )
  ) {
    return join(directory, record.filename)
  }
  return undefined
}
