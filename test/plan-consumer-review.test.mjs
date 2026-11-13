// Independent regression probes for consumers of mutable plan filenames.
// Run against the production bundle: node build.mjs, then node --test this file.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { loadBuiltRuntime } from './helpers/ink-built-runtime.mjs'

const previousCwd = process.cwd()
const temporaryRoot = realpathSync.native(tmpdir())
const scratch = realpathSync.native(
  mkdtempSync(join(temporaryRoot, 'tau-plan-consumer-review-')),
)
const project = join(scratch, 'project')
const config = join(scratch, 'config')
mkdirSync(project)
mkdirSync(config)
writeFileSync(
  join(config, 'settings.json'),
  JSON.stringify({ plansDirectory: '.', cleanupPeriodDays: 0 }),
)
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: config,
  CLAUDE_CODE_TMPDIR: join(scratch, 'tmp'),
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDEX_DISABLE_MODEL_PRICING: '1',
  DISABLE_TELEMETRY: '1',
})
delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
process.chdir(project)

const r = await loadBuiltRuntime({
  paths: [
    'src/bootstrap/state.ts',
    'src/utils/plans.ts',
    'src/utils/planFileStorage.ts',
    'src/utils/fileHistory.ts',
    'src/utils/sessionStorage.ts',
    'src/tools/FileWriteTool/FileWriteTool.ts',
    'src/tools/FileEditTool/FileEditTool.ts',
  ],
  exports: [
    'getSessionId',
    'switchSession',
    'setPlanSlug',
    'getPlanSlug',
    'getPlanFilePath',
    'getPlansDirectory',
    'getPlanMetadataPath',
    'renameStoredPlanFile',
    'copyPlanForFork',
    'copyFileHistoryForResume',
    'fileHistoryTrackEdit',
    'fileHistoryMakeSnapshot',
    'fileHistoryRewind',
    'fileHistoryRestoreStateFromLog',
    'rebasePlanFileHistorySnapshots',
    'FileWriteTool',
    'FileEditTool',
  ],
})

after(() => {
  process.chdir(previousCwd)
  const child = relative(temporaryRoot, scratch)
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10 })
})

function plan(content = '# Plan baseline\n') {
  const sessionId = randomUUID()
  r.switchSession(sessionId)
  const planId = `plan-${randomUUID()}`
  r.setPlanSlug(sessionId, planId)
  const path = r.getPlanFilePath()
  writeFileSync(path, content)
  return { sessionId, planId, path, content }
}

function history() {
  let state = {
    snapshots: [
      {
        messageId: randomUUID(),
        trackedFileBackups: {},
        timestamp: new Date(),
      },
    ],
    trackedFiles: new Set(),
    snapshotSequence: 1,
  }
  return {
    get state() {
      return state
    },
    update(fn) {
      state = fn(state)
    },
  }
}

async function rename(source, title) {
  return r.renameStoredPlanFile({
    directory: r.getPlansDirectory(),
    planId: source.planId,
    title,
    shouldProceed: () => true,
    persistReference: async () => {},
  })
}

test('a fork rewind cannot restore or recreate files belonging to the source plan', async () => {
  const source = plan('# Source baseline\n')
  const sourceHistory = history()
  const beforeEdit = sourceHistory.state.snapshots[0].messageId
  await r.fileHistoryTrackEdit(sourceHistory.update, source.path, beforeEdit)
  writeFileSync(source.path, '# Source current content\n')
  await r.fileHistoryMakeSnapshot(sourceHistory.update, randomUUID())
  const published = await rename(source, `source-review-${randomUUID()}`)
  const sourceLog = {
    messages: [
      {
        type: 'user',
        sessionId: source.sessionId,
        slug: source.planId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Fork this approved plan.' },
      },
    ],
    planFileReference: published.reference,
    fileHistorySnapshots: sourceHistory.state.snapshots,
  }
  const forkSession = randomUUID()
  assert.equal(await r.copyPlanForFork(sourceLog, forkSession), true)
  r.switchSession(forkSession)
  const forkPath = r.getPlanFilePath()
  assert.notEqual(forkPath, published.newPath)
  assert.equal(readFileSync(forkPath, 'utf8'), '# Source current content\n')
  await r.copyFileHistoryForResume(sourceLog)
  let forkState
  r.fileHistoryRestoreStateFromLog(sourceLog.fileHistorySnapshots, (value) => {
    forkState = value
  })
  await r.fileHistoryRewind((update) => {
    forkState = update(forkState)
  }, beforeEdit)
  assert.equal(
    existsSync(source.path),
    false,
    "fork rewind must not resurrect the source plan's retired random filename",
  )
  assert.equal(
    readFileSync(published.newPath, 'utf8'),
    '# Source current content\n',
    'the source plan must remain unchanged by branch history operations',
  )
})

test('corrupt plan metadata does not prevent writing unrelated text, code, or Markdown files', async () => {
  const source = plan()
  await rename(source, `corrupt-review-${randomUUID()}`)
  const metadataPath = r.getPlanMetadataPath(project, source.planId)
  const originalMetadata = readFileSync(metadataPath, 'utf8')
  writeFileSync(metadataPath, '{invalid')
  try {
    const context = { readFileState: new Map(), updateFileHistoryState() {} }
    for (const [extension, content] of [
      ['txt', 'ordinary application data\n'],
      ['ts', 'export const unrelated = true\n'],
      ['md', '# An unrelated project document\n'],
    ]) {
      const file = join(project, `unrelated-${randomUUID()}.${extension}`)
      await r.FileWriteTool.call(
        { file_path: file, content },
        context,
        undefined,
        { uuid: randomUUID() },
      )
      assert.equal(readFileSync(file, 'utf8'), content)
    }
  } finally {
    writeFileSync(metadataPath, originalMetadata)
  }
})

test('fork history rebasing clones plan paths while preserving ordinary project history and backup contents', async () => {
  const source = plan()
  const published = await rename(source, `rebase-review-${randomUUID()}`)
  const targetId = `plan-${randomUUID()}`
  const ordinary = join(project, 'application.ts')
  const sourceAgent = join(project, `${source.planId}-agent-worker-1.md`)
  const original = [
    {
      messageId: randomUUID(),
      timestamp: new Date(),
      trackedFileBackups: {
        [source.path]: {
          backupFileName: 'stable-main@v1',
          version: 1,
          backupTime: new Date(),
        },
        [sourceAgent]: {
          backupFileName: 'agent@v2',
          version: 2,
          backupTime: new Date(),
        },
        [ordinary]: {
          backupFileName: 'application@v3',
          version: 3,
          backupTime: new Date(),
        },
      },
    },
  ]
  const sourceKeys = Object.keys(original[0].trackedFileBackups)
  const rebased = r.rebasePlanFileHistorySnapshots(
    original,
    source.planId,
    targetId,
    project,
  )
  assert.notEqual(rebased, original)
  assert.deepEqual(
    Object.keys(original[0].trackedFileBackups),
    sourceKeys,
    'the source session snapshot is immutable',
  )
  assert.deepEqual(Object.keys(rebased[0].trackedFileBackups), [
    join(project, `${targetId}.md`),
    join(project, `${targetId}-agent-worker-1.md`),
    ordinary,
  ])
  assert.equal(
    rebased[0].trackedFileBackups[join(project, `${targetId}.md`)],
    original[0].trackedFileBackups[source.path],
  )
  assert.equal(
    rebased[0].trackedFileBackups[ordinary],
    original[0].trackedFileBackups[ordinary],
  )
  assert.equal(readFileSync(published.newPath, 'utf8'), source.content)
})

test('corrupt plan metadata does not prevent tracking an unrelated file for rewind', async () => {
  const source = plan()
  await rename(source, `history-review-${randomUUID()}`)
  const metadataPath = r.getPlanMetadataPath(project, source.planId)
  const originalMetadata = readFileSync(metadataPath, 'utf8')
  writeFileSync(metadataPath, '{invalid')
  const file = join(project, `unrelated-${randomUUID()}.txt`)
  writeFileSync(file, 'ordinary baseline\n')
  const state = history()
  try {
    await r.fileHistoryTrackEdit(
      state.update,
      file,
      state.state.snapshots[0].messageId,
    )
    assert.equal(state.state.trackedFiles.size, 1)
  } finally {
    writeFileSync(metadataPath, originalMetadata)
  }
})

test('corrupt filename ownership blocks that plan without blocking unregistered project files', async () => {
  const source = plan()
  const published = await rename(source, `ownership-review-${randomUUID()}`)
  const registry = join(
    project,
    '.plan-metadata',
    'names',
    `${published.reference.filename}.json`,
  )
  const original = readFileSync(registry, 'utf8')
  writeFileSync(registry, '{invalid')
  try {
    const context = {
      readFileState: new Map([
        [
          published.newPath,
          {
            content: source.content,
            timestamp: Math.floor(statSync(published.newPath).mtimeMs),
          },
        ],
      ]),
      updateFileHistoryState() {},
    }
    await assert.rejects(
      r.FileWriteTool.call(
        {
          file_path: published.newPath,
          content: 'Do not replace the owned plan',
        },
        context,
        undefined,
        { uuid: randomUUID() },
      ),
      /JSON|ownership|metadata/i,
    )
    assert.equal(readFileSync(published.newPath, 'utf8'), source.content)
    const ordinary = join(project, `unregistered-${randomUUID()}.md`)
    await r.FileWriteTool.call(
      { file_path: ordinary, content: '# Ordinary document\n' },
      context,
      undefined,
      { uuid: randomUUID() },
    )
    assert.equal(readFileSync(ordinary, 'utf8'), '# Ordinary document\n')
  } finally {
    writeFileSync(registry, original)
  }
})

test('a symbolic file alias cannot recreate the retired plan after rename', async (t) => {
  const source = plan()
  const alias = join(project, `plan-file-alias-${randomUUID()}.md`)
  try {
    symlinkSync(source.path, alias, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(
        'The host does not permit file symlinks; exercise this on a symlink-capable runner.',
      )
      return
    }
    throw error
  }
  const published = await rename(source, `symlink-review-${randomUUID()}`)
  try {
    const context = { readFileState: new Map(), updateFileHistoryState() {} }
    const input = {
      file_path: alias,
      content: '# Stale symbolic alias replacement\n',
    }
    const validation = await r.FileWriteTool.validateInput(input, context)
    assert.equal(
      validation.result,
      false,
      'a dangling alias to a retired plan is not a new application file',
    )
    await assert.rejects(
      r.FileWriteTool.call(input, context, undefined, { uuid: randomUUID() }),
      /renamed|moved/,
    )
    assert.equal(existsSync(source.path), false)
    assert.equal(readFileSync(published.newPath, 'utf8'), source.content)
  } finally {
    unlinkSync(alias)
  }
})
